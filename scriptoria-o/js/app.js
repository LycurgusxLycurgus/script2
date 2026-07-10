const { createApp, ref, reactive, computed, onMounted, nextTick, watch } = Vue;

const APP_VERSION = '3.0';
const MAX_DIAGNOSTIC_ENTRIES = 60;
const PRIMARY_GEMINI_MODEL = 'gemini-3-flash-preview';
const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const FALLBACK_RETRY_DELAY_MS = 30000;
const CAREER_STORAGE_KEY = 'scriptoria_career';
const WORDS_PER_PAGE = 275;
const SUPPORTED_INLINE_MIME_TYPES = new Set([
    'application/pdf',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif'
]);

const EXTENSION_TO_MIME = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif'
};

const generateDiagnosticId = (prefix = 'diag') => {
    if (window.crypto?.randomUUID) return `${prefix}_${window.crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const truncateText = (value, max = 600) => {
    if (typeof value !== 'string') return value;
    return value.length > max ? `${value.slice(0, max)}...[truncated]` : value;
};

const redactString = (value) => {
    if (typeof value !== 'string') return value;

    return value
        .replace(/([?&]key=)[^&]+/gi, '$1REDACTED')
        .replace(/AIza[0-9A-Za-z\-_]+/g, 'REDACTED_API_KEY');
};

const redactMeta = (value, depth = 0) => {
    if (depth > 4 || value == null) return value;
    if (typeof value === 'string') return redactString(truncateText(value));
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => redactMeta(item, depth + 1));

    const safeObject = {};
    Object.entries(value).forEach(([key, currentValue]) => {
        if (/key|token|authorization|secret|password/i.test(key)) {
            safeObject[key] = 'REDACTED';
        } else if (key === 'data') {
            safeObject[key] = '[REDACTED_DATA_URL]';
        } else {
            safeObject[key] = redactMeta(currentValue, depth + 1);
        }
    });
    return safeObject;
};

const diagnostics = (() => {
    const entries = [];

    const push = (level, event, meta = {}) => {
        const entry = {
            ts: new Date().toISOString(),
            level,
            event,
            ...redactMeta(meta)
        };

        entries.push(entry);
        if (entries.length > MAX_DIAGNOSTIC_ENTRIES) entries.shift();
        return entry;
    };

    return {
        info: (event, meta) => push('info', event, meta),
        warn: (event, meta) => push('warn', event, meta),
        error: (event, meta) => push('error', event, meta),
        getEntries: () => [...entries]
    };
})();

const app = createApp({
    setup() {
        // --- State ---
        const appState = ref('INIT'); // INIT, LOGIN, SETUP_KEY, SETUP_STYLE, STYLE_REVIEW, CAREER_SETUP, ASSIGNMENT_DECODER, DASHBOARD, QUESTION_GUIDANCE, GENERATING, RESULT
        const systemMessage = ref('Initializing Obsidian Core...');
        const errorMsg = ref('');
        const isShake = ref(false);
        const generatedContent = ref('');
        const thoughtLog = ref([]); // For Thinking Stream
        const copyBtnText = ref('Copy');
        const lastSignature = ref(null);
        const lastError = ref(null);
        const hasGenerationAttempted = ref(false);
        const generationAttemptCount = ref(0);
        const recentGenerationAttempts = ref([]);
        const lastSuccessfulGenerationAt = ref(null);
        const lastGenerationMetrics = ref(null);
        const decoderNotice = ref('');

        // --- Data: Auth ---
        const credentials = Array.isArray(window.SCRIPTORIA_USERS) ? window.SCRIPTORIA_USERS : [];

        const form = reactive({
            username: '',
            password: '',
            apiKey: '',
            acceptTerms: false
        });

        const isTermsModalOpen = ref(false);

        // --- Data: College Workflow ---
        const careerForm = reactive({
            career: localStorage.getItem(CAREER_STORAGE_KEY) || ''
        });

        const assignmentMeta = reactive({
            career: careerForm.career,
            lengthMode: 'pages',
            requestedPages: 3,
            targetWords: WORDS_PER_PAGE * 3,
            citationRequired: false,
            citationStyle: 'none',
            citationInstructions: '',
            enhancementQuestionsEnabled: false,
            enhancementQuestionsAuto: true
        });

        const decoderForm = reactive({
            assignmentText: '',
            files: []
        });

        const guidanceFlow = reactive({
            questions: [],
            answers: {},
            isPreparing: false,
            wasShownForCurrentDraft: false
        });

        const pendingCareerNextState = ref('ASSIGNMENT_DECODER');

        const citationOptions = [
            { value: 'none', label: 'None' },
            { value: 'apa7', label: 'APA 7' },
            { value: 'mla9', label: 'MLA 9' },
            { value: 'chicago_notes', label: 'Chicago Notes' },
            { value: 'chicago_author_date', label: 'Chicago Author-Date' },
            { value: 'ieee', label: 'IEEE' },
            { value: 'vancouver', label: 'Vancouver' },
            { value: 'harvard', label: 'Harvard' },
            { value: 'custom', label: 'Custom' }
        ];

        const guidanceQuestionsEnabled = computed({
            get() {
                const pages = Number(assignmentMeta.requestedPages) || 0;
                return assignmentMeta.enhancementQuestionsEnabled ||
                    (assignmentMeta.enhancementQuestionsAuto && assignmentMeta.lengthMode === 'pages' && pages >= 10);
            },
            set(value) {
                assignmentMeta.enhancementQuestionsAuto = false;
                assignmentMeta.enhancementQuestionsEnabled = !!value;
            }
        });

        // --- Data: Style Interview ---
        const interviewStep = ref(0);
        const styleForm = reactive({
            vibe: '',
            argument: '',
            howto: '',
            cancel: ''
        });

        const questionBank = [
            {
                id: 'vibe',
                label: 'The "Vibe" Check',
                model: 'vibe',
                questionPool: [
                    'Describe the room you\'re in right now.',
                    'Paint the space around you as if we are standing there.',
                    'What does your current environment feel like from your point of view?'
                ],
                subtitlePool: [
                    'Don\'t just list objects-describe what it feels like to be there.',
                    'Use atmosphere, not inventory. Let us feel the place.',
                    'Focus on mood, texture, and your personal lens.'
                ],
                placeholderPool: [
                    'Write 4-5 lines naturally, as if texting a friend...',
                    'Give 4-5 lines that sound exactly like your normal voice...',
                    'Write a short paragraph in your everyday tone...'
                ]
            },
            {
                id: 'argument',
                label: 'The Silly Argument',
                model: 'argument',
                questionPool: [
                    'Pick a playful opinion and defend it.',
                    'Choose a harmless hot take and argue for it.',
                    'Take a fun debate side and convince us you\'re right.'
                ],
                subtitlePool: [
                    'Choose any light topic and make your case clearly.',
                    'The point is your persuasive style, not being objectively correct.',
                    'Show your argument voice in a low-stakes opinion.'
                ],
                placeholderPool: [
                    'Explain why you\'re right in 4-5 lines...',
                    'Write 4-5 lines of your most convincing reasoning...',
                    'Defend your take in a short paragraph...'
                ]
            },
            {
                id: 'howto',
                label: 'The Quick How-To',
                model: 'howto',
                questionPool: [
                    'Explain something simple to a beginner.',
                    'Teach a tiny everyday skill to someone new.',
                    'Give beginner instructions for a simple task.'
                ],
                subtitlePool: [
                    'Break it down in clear steps without sounding robotic.',
                    'Keep it practical and easy to follow.',
                    'Aim for clarity while keeping your natural tone.'
                ],
                placeholderPool: [
                    'Write clear instructions in 4-5 lines...',
                    'Give a short step-by-step in your own voice...',
                    'Write a brief how-to paragraph...'
                ]
            },
            {
                id: 'cancel',
                label: 'The "I Can\'t Make It" Message',
                model: 'cancel',
                questionPool: [
                    'You have to cancel plans last minute.',
                    'Send a quick message because you cannot make it anymore.',
                    'Write the text you would send when canceling on short notice.'
                ],
                subtitlePool: [
                    'Write it exactly how you would actually text.',
                    'Be honest-awkward, polite, brief, or direct, your real style.',
                    'Show your natural social tone under pressure.'
                ],
                placeholderPool: [
                    'Write your message in 4-5 lines...',
                    'Type the exact message you would send...',
                    'Write a realistic cancellation text in your voice...'
                ]
            }
        ];

        const pickRandom = (items) => items[Math.floor(Math.random() * items.length)];
        const buildInterviewQuestions = () => questionBank.map((entry) => ({
            id: entry.id,
            label: entry.label,
            model: entry.model,
            question: pickRandom(entry.questionPool),
            subtitle: pickRandom(entry.subtitlePool),
            placeholder: pickRandom(entry.placeholderPool)
        }));
        const questions = ref(buildInterviewQuestions());

        const currentQuestion = computed(() => questions.value[interviewStep.value] || questions.value[0]);

        const refreshInterviewQuestions = () => {
            questions.value = buildInterviewQuestions();
            interviewStep.value = 0;
        };

        const resetStyleForm = () => {
            styleForm.vibe = '';
            styleForm.argument = '';
            styleForm.howto = '';
            styleForm.cancel = '';
        };

        const styleValidationCases = [
            {
                id: 'text_preview',
                type: 'text',
                label: 'Text Assignment Preview',
                topic: 'Do school uniforms improve student outcomes?',
                subject: 'Education',
                taskType: 'Argumentative Response',
                details: 'Take one clear position, include one counterargument, and end with a practical conclusion.'
            },
            {
                id: 'math_preview',
                type: 'math',
                label: 'Math Assignment Preview',
                topic: 'Quadratic equation and interpretation',
                subject: 'Algebra',
                taskType: 'Solve and Explain',
                details: 'Solve a quadratic step-by-step and explain what each solution means in context.'
            }
        ];

        const styleReview = reactive({
            activePreviewId: styleValidationCases[0].id,
            previews: {
                text_preview: '',
                math_preview: ''
            },
            isPreparing: false,
            error: ''
        });

        const activeStylePreview = computed(() => {
            return styleValidationCases.find((preview) => preview.id === styleReview.activePreviewId) || styleValidationCases[0];
        });

        const activeStylePreviewContent = computed(() => {
            return styleReview.previews[styleReview.activePreviewId] || '';
        });

        // --- Data: Dashboard ---
        const homeworkType = ref('text'); // 'text' or 'math'
        const homeworkForm = reactive({
            topic: '',
            subject: '',
            taskType: '',
            details: '',
            files: []
        });
        const history = ref([]);
        const isSidebarOpen = ref(false);

        const clearLastError = () => {
            lastError.value = null;
        };

        const pushGenerationAttempt = (attempt) => {
            recentGenerationAttempts.value.unshift({
                at: new Date().toISOString(),
                ...attempt
            });

            if (recentGenerationAttempts.value.length > 10) {
                recentGenerationAttempts.value.pop();
            }
        };

        const getConnectionDetails = () => {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (!connection) return null;

            return {
                effectiveType: connection.effectiveType || null,
                downlink: connection.downlink || null,
                rtt: connection.rtt || null,
                saveData: connection.saveData || false
            };
        };

        const buildRuntimeContext = () => ({
            appVersion: APP_VERSION,
            appState: appState.value,
            homeworkType: homeworkType.value,
            careerPresent: !!assignmentMeta.career?.trim(),
            lengthMode: assignmentMeta.lengthMode,
            requestedPages: assignmentMeta.lengthMode === 'pages' ? Number(assignmentMeta.requestedPages) || null : null,
            targetWords: Number(assignmentMeta.targetWords) || null,
            citationRequired: !!assignmentMeta.citationRequired,
            citationStyle: assignmentMeta.citationStyle,
            guidanceQuestionCount: guidanceFlow.questions.length,
            guidanceAnsweredCount: Object.keys(guidanceFlow.answers).length,
            decoderFileCount: decoderForm.files.length,
            hasGenerationAttempted: hasGenerationAttempted.value,
            generationAttemptCount: generationAttemptCount.value,
            lastSuccessfulGenerationAt: lastSuccessfulGenerationAt.value,
            fileCount: homeworkForm.files.length,
            files: homeworkForm.files.map(file => ({
                name: file.name,
                type: file.mimeType || file.type || 'unknown',
                size: file.size || null
            })),
            hasStyleProfile: !!localStorage.getItem('scriptoria_style_profile'),
            hasLastSignature: !!lastSignature.value,
            recentGenerationAttempts: recentGenerationAttempts.value,
            lastGenerationMetrics: lastGenerationMetrics.value,
            page: {
                href: window.location.href,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight
                },
                screen: {
                    width: window.screen?.width || null,
                    height: window.screen?.height || null
                }
            },
            connection: getConnectionDetails()
        });

        const setUserVisibleError = (error, stage) => {
            const supportId = generateDiagnosticId('support');
            const status = error?.status || null;
            const statusText = error?.statusText || null;
            const requestId = error?.requestId || null;
            const responsePreview = error?.responsePreview || null;
            const baseMessage = error?.message || `Unexpected error during ${stage}.`;
            const finalMessage = status === 400 && responsePreview
                ? `Gemini rejected this request. ${responsePreview}`
                : baseMessage;

            lastError.value = {
                supportId,
                stage,
                message: finalMessage,
                requestId,
                status,
                statusText
            };

            diagnostics.error('ui.failure', {
                supportId,
                stage,
                message: finalMessage,
                requestId,
                status,
                statusText,
                responsePreview,
                runtime: buildRuntimeContext()
            });
        };

        const downloadDiagnosticReport = () => {
            const report = redactMeta({
                generatedAt: new Date().toISOString(),
                appVersion: APP_VERSION,
                browser: {
                    userAgent: navigator.userAgent,
                    language: navigator.language,
                    online: navigator.onLine,
                    platform: navigator.platform || null
                },
                lastError: lastError.value,
                runtime: buildRuntimeContext(),
                diagnostics: diagnostics.getEntries()
            });

            const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `scriptoria-diagnostic-${Date.now()}.json`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        };

        const installGlobalDiagnostics = () => {
            window.addEventListener('error', (event) => {
                diagnostics.error('window.error', {
                    message: event.message,
                    filename: event.filename,
                    lineno: event.lineno,
                    colno: event.colno,
                    stack: event.error?.stack || null
                });
            });

            window.addEventListener('unhandledrejection', (event) => {
                diagnostics.error('window.unhandledrejection', {
                    reason: event.reason?.message || String(event.reason),
                    stack: event.reason?.stack || null
                });
            });
        };

        const getRequestSummary = (payload) => ({
            hasSystemInstruction: !!payload?.system_instruction,
            contentCount: Array.isArray(payload?.contents) ? payload.contents.length : 0,
            filePartCount: Array.isArray(payload?.contents)
                ? payload.contents.reduce((total, content) => total + (content.parts || []).filter(part => part.inline_data).length, 0)
                : 0
        });

        const buildGeminiStreamUrl = (apiKey, model) =>
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        const isModelAvailabilityError = (error) => {
            const message = `${error?.message || ''} ${error?.statusText || ''} ${error?.responsePreview || ''}`.toLowerCase();
            return [429, 500, 503].includes(error?.status) || [
                'high demand',
                'overloaded',
                'unavailable',
                'resource_exhausted',
                'quota exceeded',
                'try again later'
            ].some(fragment => message.includes(fragment));
        };

        const createRetryScheduledError = (baseError) => {
            const error = new Error(`Google API is under high demand. Your request is being retried automatically in ${Math.round(FALLBACK_RETRY_DELAY_MS / 1000)} seconds.`);
            error.requestId = baseError?.requestId || null;
            error.status = baseError?.status || null;
            error.statusText = baseError?.statusText || null;
            error.responsePreview = baseError?.responsePreview || null;
            error.errorStage = 'retry_wait';
            return error;
        };

        const fetchWithDiagnostics = async (url, payload, context = {}) => {
            const requestId = generateDiagnosticId('req');
            const startedAt = performance.now();
            diagnostics.info('request.start', {
                requestId,
                url,
                context,
                requestSummary: getRequestSummary(payload)
            });

            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } catch (networkError) {
                diagnostics.error('request.network_error', {
                    requestId,
                    context,
                    durationMs: Math.round(performance.now() - startedAt),
                    message: networkError?.message || String(networkError),
                    stack: networkError?.stack || null
                });

                const error = new Error('Network request failed.');
                error.requestId = requestId;
                error.errorStage = 'fetch';
                throw error;
            }

            if (!response.ok) {
                const responseText = await response.text().catch(() => '');
                const error = new Error(`HTTP ${response.status} ${response.statusText}`);
                error.requestId = requestId;
                error.status = response.status;
                error.statusText = response.statusText;
                error.responsePreview = truncateText(responseText, 300);
                error.errorStage = 'fetch';

                diagnostics.error('request.http_error', {
                    requestId,
                    context,
                    status: response.status,
                    statusText: response.statusText,
                    durationMs: Math.round(performance.now() - startedAt),
                    responsePreview: responseText
                });

                throw error;
            }

            diagnostics.info('request.success', {
                requestId,
                context,
                status: response.status,
                durationMs: Math.round(performance.now() - startedAt)
            });

            return { response, requestId };
        };

        const readSseStream = async (response, onEvent, context = {}) => {
            const reader = response.body?.getReader();
            if (!reader) throw new Error('Readable stream not available on response.');

            const decoder = new TextDecoder();
            let buffer = '';
            let eventCount = 0;

            const processLine = (line) => {
                if (!line.startsWith('data: ')) return;

                const jsonStr = line.slice(6).trim();
                if (!jsonStr || jsonStr === '[DONE]') return;

                try {
                    eventCount += 1;
                    onEvent(JSON.parse(jsonStr));
                } catch (parseError) {
                    diagnostics.warn('sse.parse_error', {
                        context,
                        errorStage: 'sse_parse',
                        message: parseError?.message || String(parseError),
                        linePreview: jsonStr
                    });
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                lines.forEach(processLine);
            }

            const remaining = buffer.trim();
            if (remaining) {
                diagnostics.info('sse.final_buffer_flushed', {
                    context,
                    bufferLength: remaining.length
                });
                processLine(remaining);
            }

            return { eventCount };
        };

        const getFileExtension = (fileName = '') => {
            const parts = fileName.toLowerCase().split('.');
            return parts.length > 1 ? parts.pop() : '';
        };

        const resolveSupportedMimeType = (file) => {
            const declaredType = (file.type || '').toLowerCase();
            if (declaredType === 'image/jpg') return 'image/jpeg';
            if (SUPPORTED_INLINE_MIME_TYPES.has(declaredType)) return declaredType;

            const extension = getFileExtension(file.name);
            return EXTENSION_TO_MIME[extension] || null;
        };

        const getFileMetadata = (files = []) => files.map(file => ({
            name: file.name,
            type: file.mimeType || file.type || 'unknown',
            size: file.size || null
        }));

        const getUnsupportedFiles = (files = []) =>
            files.filter(file => !file.mimeType || !SUPPORTED_INLINE_MIME_TYPES.has(file.mimeType));

        const validateSupportedFiles = (files = [], stage = 'file upload') => {
            const unsupportedFiles = getUnsupportedFiles(files);
            if (unsupportedFiles.length === 0) return true;

            const error = new Error(`Unsupported file type: ${unsupportedFiles[0].name}. Use PNG, JPG, WEBP, HEIC, HEIF, PDF, or TXT.`);
            setUserVisibleError(error, stage);
            return false;
        };

        // --- Schema: Style Analysis ---
        const styleAnalysisSchema = {
            type: "object",
            properties: {
                style_profile: {
                    type: "object",
                    description: "A detailed analysis of the writer's style.",
                    properties: {
                        diction: { type: "string", description: "Analysis of vocabulary, formality, and complexity." },
                        syntax: { type: "string", description: "Analysis of sentence structure, length, and pacing." },
                        rhythm: { type: "string", description: "Analysis of punctuation, cadence, and flow." },
                        tone: { type: "string", description: "Analysis of attitude, stance, and persuasion." },
                        humanisms: { type: "string", description: "Specific idiosyncrasies, pet phrases, and grammar quirks." }
                    },
                    required: ["diction", "syntax", "rhythm", "tone", "humanisms"]
                },
                system_prompt: {
                    type: "string",
                    description: "The replicating system prompt. A direct instruction to the AI to write in this style, incorporating all principles and don's & dont's rules."
                }
            },
            required: ["style_profile", "system_prompt"]
        };

        const assignmentDecoderSchema = {
            type: "object",
            properties: {
                homeworkType: {
                    type: "string",
                    enum: ["text", "math"]
                },
                topic: { type: "string" },
                subject: { type: "string" },
                taskType: { type: "string" },
                details: { type: "string" },
                recommendedPages: { type: "number" },
                citationRequired: { type: "boolean" },
                citationStyle: {
                    type: "string",
                    enum: ["none", "apa7", "mla9", "chicago_notes", "chicago_author_date", "ieee", "vancouver", "harvard", "custom"]
                },
                confidence: {
                    type: "string",
                    enum: ["low", "medium", "high"]
                },
                missingInfo: {
                    type: "array",
                    items: { type: "string" }
                }
            },
            required: ["homeworkType", "topic", "subject", "taskType", "details", "recommendedPages", "citationRequired", "citationStyle", "confidence", "missingInfo"]
        };

        const guidanceQuestionsSchema = {
            type: "object",
            properties: {
                questions: {
                    type: "array",
                    minItems: 1,
                    maxItems: 3,
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            question: { type: "string" },
                            reason: { type: "string" },
                            recommendedOptionId: { type: "string" },
                            customPlaceholder: { type: "string" },
                            options: {
                                type: "array",
                                minItems: 2,
                                maxItems: 3,
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "string" },
                                        label: { type: "string" },
                                        value: { type: "string" }
                                    },
                                    required: ["id", "label", "value"]
                                }
                            }
                        },
                        required: ["id", "question", "reason", "recommendedOptionId", "customPlaceholder", "options"]
                    }
                }
            },
            required: ["questions"]
        };

        const normalizeNumber = (value, fallback) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        const syncTargetWords = () => {
            if (assignmentMeta.lengthMode === 'pages') {
                assignmentMeta.requestedPages = normalizeNumber(assignmentMeta.requestedPages, 3);
                assignmentMeta.targetWords = Math.round(assignmentMeta.requestedPages * WORDS_PER_PAGE);
            } else {
                assignmentMeta.targetWords = normalizeNumber(assignmentMeta.targetWords, WORDS_PER_PAGE * 3);
            }
        };
        const saveCareerValue = (career) => {
            const cleanCareer = (career || '').trim();
            if (!cleanCareer) return false;
            careerForm.career = cleanCareer;
            assignmentMeta.career = cleanCareer;
            localStorage.setItem(CAREER_STORAGE_KEY, cleanCareer);
            return true;
        };
        const requireCareerBeforeDashboard = (nextState = 'ASSIGNMENT_DECODER') => {
            loadHistory();
            const storedCareer = localStorage.getItem(CAREER_STORAGE_KEY) || '';
            if (storedCareer.trim()) {
                saveCareerValue(storedCareer);
                appState.value = nextState;
                return;
            }
            pendingCareerNextState.value = nextState;
            appState.value = 'CAREER_SETUP';
        };
        const saveCareerAndContinue = () => {
            if (!saveCareerValue(careerForm.career)) {
                errorMsg.value = 'Add your career or major to continue.';
                triggerShake();
                return;
            }
            errorMsg.value = '';
            diagnostics.info('career.saved', {
                careerPresent: true
            });
            appState.value = pendingCareerNextState.value || 'ASSIGNMENT_DECODER';
        };
        const saveAssignmentCareer = () => {
            if (assignmentMeta.career?.trim()) {
                saveCareerValue(assignmentMeta.career);
            }
        };
        const setRequestedPages = (value) => {
            assignmentMeta.requestedPages = Math.max(1, Math.round(normalizeNumber(value, 1)));
            syncTargetWords();
        };
        const adjustRequestedPages = (delta) => setRequestedPages((Number(assignmentMeta.requestedPages) || 1) + delta);
        const getCitationLabel = (value) => {
            const option = citationOptions.find(item => item.value === value);
            return option?.label || 'Custom';
        };
        const getLengthInstruction = () => {
            syncTargetWords();
            if (assignmentMeta.lengthMode === 'pages') {
                return `${assignmentMeta.requestedPages} page(s), approximately ${assignmentMeta.targetWords} words.`;
            }
            return `Approximately ${assignmentMeta.targetWords} words.`;
        };
        const getCitationInstruction = () => {
            if (!assignmentMeta.citationRequired || assignmentMeta.citationStyle === 'none') {
                return 'No formal citation style is required unless the user details explicitly ask for one.';
            }
            const customDetails = assignmentMeta.citationInstructions?.trim()
                ? ` Extra citation instructions: ${assignmentMeta.citationInstructions.trim()}`
                : '';
            return `Use ${getCitationLabel(assignmentMeta.citationStyle)} citation style.${customDetails} Cite uploaded/source material when available. Since this app does not perform live web research, do not invent page numbers or obscure source details; if a citation depends on model memory, make it conservative and verifiable.`;
        };
        const getGuidanceSummary = () => {
            if (!guidanceFlow.questions.length) return 'No extra guidance questions were answered.';
            const answers = guidanceFlow.questions.map((question) => {
                const answer = guidanceFlow.answers[question.id] || {};
                const customText = answer.customText?.trim();
                if (answer.selectedOptionId === 'custom') {
                    return `- ${question.question} Answer: ${customText || 'Custom answer selected, but no extra text was provided.'}`;
                }
                const selectedOption = question.options.find(option => option.id === answer.selectedOptionId);
                const selectedValue = selectedOption?.value || selectedOption?.label || 'Recommended option';
                return `- ${question.question} Answer: ${selectedValue}`;
            });
            return answers.join('\n');
        };
        const buildGenerationContext = () => ({
            career: assignmentMeta.career?.trim() || 'General college student',
            lengthInstruction: getLengthInstruction(),
            citationInstruction: getCitationInstruction(),
            guidanceInstruction: getGuidanceSummary()
        });
        const applyCollegePromptContext = (template) => {
            const context = buildGenerationContext();
            return template
                .replace('{{COLLEGE_CONTEXT_RULES}}', PROMPTS.COLLEGE_CONTEXT_RULES || '')
                .replace('{{CAREER}}', context.career)
                .replace('{{LENGTH_INSTRUCTION}}', context.lengthInstruction)
                .replace('{{CITATION_INSTRUCTION}}', context.citationInstruction)
                .replace('{{GUIDANCE_ANSWERS}}', context.guidanceInstruction);
        };
        const buildUserPrompt = () => {
            const userPromptTemplate = homeworkType.value === 'math' ? PROMPTS.HOMEWORK_MATH : PROMPTS.HOMEWORK_TEXT;
            return applyCollegePromptContext(userPromptTemplate)
                .replace('{{TASK_TYPE}}', homeworkForm.taskType || 'General Task')
                .replace('{{TOPIC}}', homeworkForm.topic)
                .replace('{{SUBJECT}}', homeworkForm.subject || 'General')
                .replace('{{DETAILS}}', homeworkForm.details || 'None');
        };
        const resetGuidanceForDraft = () => {
            guidanceFlow.questions = [];
            guidanceFlow.answers = {};
            guidanceFlow.wasShownForCurrentDraft = false;
        };
        const buildAssignmentDecoderPrompt = () => {
            const text = decoderForm.assignmentText?.trim() || 'The assignment instructions are provided in the uploaded files.';
            return PROMPTS.ASSIGNMENT_DECODER
                .replace('{{ASSIGNMENT_TEXT}}', text)
                .replace('{{CAREER}}', assignmentMeta.career || 'General college student')
                .replace('{{FILE_COUNT}}', String(decoderForm.files.length));
        };

        const buildGuidanceQuestionsPrompt = () => {
            const context = buildGenerationContext();
            return PROMPTS.GUIDANCE_QUESTIONS
                .replace('{{HOMEWORK_TYPE}}', homeworkType.value)
                .replace('{{TASK_TYPE}}', homeworkForm.taskType || 'General Task')
                .replace('{{TOPIC}}', homeworkForm.topic)
                .replace('{{SUBJECT}}', homeworkForm.subject || 'General')
                .replace('{{DETAILS}}', homeworkForm.details || 'None')
                .replace('{{CAREER}}', context.career)
                .replace('{{LENGTH_INSTRUCTION}}', context.lengthInstruction)
                .replace('{{CITATION_INSTRUCTION}}', context.citationInstruction);
        };

        const toggleSidebar = () => {
            isSidebarOpen.value = !isSidebarOpen.value;
        };

        const triggerShake = () => {
            isShake.value = true;
            setTimeout(() => isShake.value = false, 500);
        };

        const openTermsModal = () => {
            isTermsModalOpen.value = true;
        };

        const closeTermsModal = () => {
            isTermsModalOpen.value = false;
        };

        const checkLogin = () => {
            if (!form.acceptTerms) {
                errorMsg.value = 'You must accept the Terms and Conditions to continue.';
                triggerShake();
                return;
            }

            const valid = credentials.find(c =>
                c.u.toLowerCase() === form.username.toLowerCase() &&
                c.p === form.password
            );

            if (valid) {
                errorMsg.value = '';
                closeTermsModal();
                const storedKey = localStorage.getItem('scriptoria_api_key');
                if (storedKey) {
                    checkStyleProfile();
                } else {
                    appState.value = 'SETUP_KEY';
                }
            } else {
                errorMsg.value = 'Access Denied. Identity Unverified.';
                triggerShake();
            }
        };

        const saveKey = () => {
            if (!form.apiKey || form.apiKey.length < 10) {
                errorMsg.value = 'Invalid API Key format.';
                triggerShake();
                return;
            }

            localStorage.setItem('scriptoria_api_key', form.apiKey);
            errorMsg.value = '';
            checkStyleProfile();
        };

        const checkStyleProfile = () => {
            const style = localStorage.getItem('scriptoria_style_profile');
            if (style) {
                requireCareerBeforeDashboard('ASSIGNMENT_DECODER');
            } else {
                appState.value = 'SETUP_STYLE';
            }
        };

        const nextStep = () => {
            const currentModel = currentQuestion.value.model;
            if (!styleForm[currentModel] || styleForm[currentModel].trim() === '') {
                triggerShake();
                return;
            }

            if (interviewStep.value < questions.value.length - 1) {
                interviewStep.value++;
            } else {
                finishStyleSetup();
            }
        };

        const prevStep = () => {
            if (interviewStep.value > 0) {
                interviewStep.value--;
            }
        };

        const buildPreviewUserPrompt = (previewCase) => {
            const userPromptTemplate = previewCase.type === 'math' ? PROMPTS.HOMEWORK_MATH : PROMPTS.HOMEWORK_TEXT;
            return applyCollegePromptContext(userPromptTemplate)
                .replace('{{TASK_TYPE}}', previewCase.taskType || 'General Task')
                .replace('{{TOPIC}}', previewCase.topic)
                .replace('{{SUBJECT}}', previewCase.subject || 'General')
                .replace('{{DETAILS}}', previewCase.details || 'None');
        };

        const generateStylePreview = async (previewCase, systemPrompt) => {
            const userPrompt = buildPreviewUserPrompt(previewCase);
            const attempts = [
                { label: 'standard', options: { feature: 'style_preview', retryStage: 'style preview', context: { previewId: previewCase.id } } },
                { label: 'lite_empty_retry', options: { feature: 'style_preview', retryStage: 'style preview', preferredModel: FALLBACK_GEMINI_MODEL, allowFallback: false, context: { previewId: previewCase.id } } }
            ];

            for (const attempt of attempts) {
                generatedContent.value = '';
                thoughtLog.value = [];
                const result = await callGeminiStream(userPrompt, systemPrompt, [], null, attempt.options);
                const output = generatedContent.value.trim();

                if (output) {
                    diagnostics.info('style_preview.complete', {
                        previewId: previewCase.id,
                        attempt: attempt.label,
                        requestId: result.requestId,
                        model: result.model,
                        outputLength: output.length,
                        textChunkCount: result.textChunkCount,
                        thoughtChunkCount: result.thoughtChunkCount
                    });
                    return generatedContent.value;
                }

                diagnostics.warn('style_preview.empty_output', {
                    previewId: previewCase.id,
                    attempt: attempt.label,
                    requestId: result.requestId,
                    model: result.model,
                    streamEventCount: result.streamEventCount,
                    thoughtChunkCount: result.thoughtChunkCount
                });
            }

            throw new Error(`Style preview generated empty output for ${previewCase.label}.`);
        };

        const prepareStyleValidationPreviews = async () => {
            const styleProfile = localStorage.getItem('scriptoria_style_profile') || 'Standard academic tone.';
            const systemPrompt = PROMPTS.SYSTEM.replace('{{STYLE_PROFILE}}', styleProfile);

            styleReview.previews.text_preview = '';
            styleReview.previews.math_preview = '';
            styleReview.activePreviewId = styleValidationCases[0].id;
            styleReview.error = '';
            styleReview.isPreparing = true;

            for (let index = 0; index < styleValidationCases.length; index++) {
                const previewCase = styleValidationCases[index];
                systemMessage.value = `Generating validation previews (${index + 1}/${styleValidationCases.length})...`;
                styleReview.previews[previewCase.id] = await generateStylePreview(previewCase, systemPrompt);
            }

            styleReview.isPreparing = false;
            appState.value = 'STYLE_REVIEW';
        };

        const selectStylePreview = (previewId) => {
            if (!styleReview.previews[previewId]) return;
            styleReview.activePreviewId = previewId;
        };

        const acceptStyleAndContinue = () => {
            requireCareerBeforeDashboard('ASSIGNMENT_DECODER');
        };

        const retryStyleTraining = () => {
            styleReview.previews.text_preview = '';
            styleReview.previews.math_preview = '';
            styleReview.activePreviewId = styleValidationCases[0].id;
            styleReview.isPreparing = false;
            styleReview.error = '';
            resetStyleForm();
            refreshInterviewQuestions();
            appState.value = 'SETUP_STYLE';
        };

        const goToManualEntry = () => { decoderNotice.value = ''; appState.value = 'DASHBOARD'; };
        const openAssignmentDecoder = () => {
            decoderNotice.value = '';
            isSidebarOpen.value = false;
            appState.value = 'ASSIGNMENT_DECODER';
        };

        const applyDecodedAssignment = (decoded) => {
            homeworkType.value = decoded.homeworkType === 'math' ? 'math' : 'text';
            homeworkForm.topic = decoded.topic || '';
            homeworkForm.subject = decoded.subject || '';
            homeworkForm.taskType = decoded.taskType || '';
            homeworkForm.details = decoded.details || '';
            homeworkForm.files = [...decoderForm.files];
            const recommendedPages = normalizeNumber(decoded.recommendedPages, assignmentMeta.requestedPages || 3);
            assignmentMeta.lengthMode = 'pages';
            assignmentMeta.requestedPages = Math.max(1, Math.round(recommendedPages));
            syncTargetWords();
            assignmentMeta.citationRequired = !!decoded.citationRequired;
            assignmentMeta.citationStyle = decoded.citationStyle || 'none';
            if (!assignmentMeta.citationRequired) {
                assignmentMeta.citationStyle = 'none';
            }
            resetGuidanceForDraft();
            decoderNotice.value = `Assignment decoded with ${decoded.confidence || 'medium'} confidence. Review the fields, adjust anything your professor expects, then generate.`;
            appState.value = 'DASHBOARD';
        };

        const decodeAssignment = async () => {
            if (!decoderForm.assignmentText.trim() && decoderForm.files.length === 0) {
                errorMsg.value = 'Paste the assignment instructions or upload the assignment file.';
                triggerShake();
                return;
            }
            if (!validateSupportedFiles(decoderForm.files, 'assignment decoder')) return;
            clearLastError();
            errorMsg.value = '';
            appState.value = 'GENERATING';
            systemMessage.value = 'Reading the assignment brief...';
            thoughtLog.value = [{ text: 'Extracting university-level requirements...', isThought: true }];
            diagnostics.info('assignment.decode.start', {
                fileCount: decoderForm.files.length,
                hasText: !!decoderForm.assignmentText.trim(),
                careerPresent: !!assignmentMeta.career?.trim()
            });

            try {
                const decoded = await callGeminiStructuredStream(
                    buildAssignmentDecoderPrompt(),
                    assignmentDecoderSchema,
                    {
                        feature: 'assignment_decoder',
                        preferredModel: FALLBACK_GEMINI_MODEL,
                        allowFallback: false,
                        thinkingLevel: 'high',
                        files: decoderForm.files,
                        retryStage: 'assignment decoder'
                    }
                );
                diagnostics.info('assignment.decode.complete', {
                    homeworkType: decoded?.homeworkType || null,
                    citationRequired: !!decoded?.citationRequired,
                    citationStyle: decoded?.citationStyle || null,
                    recommendedPages: decoded?.recommendedPages || null,
                    confidence: decoded?.confidence || null,
                    missingInfoCount: Array.isArray(decoded?.missingInfo) ? decoded.missingInfo.length : 0
                });
                applyDecodedAssignment(decoded || {});
            } catch (error) {
                diagnostics.error('assignment.decode.failed', {
                    message: error?.message || String(error),
                    requestId: error?.requestId || null,
                    fileCount: decoderForm.files.length
                });
                setUserVisibleError(error, 'assignment decoder');
                appState.value = 'ASSIGNMENT_DECODER';
            }
        };

        const shouldShowGuidanceQuestions = () => {
            if (guidanceFlow.wasShownForCurrentDraft) return false;
            return guidanceQuestionsEnabled.value;
        };

        const selectGuidanceOption = (questionId, optionId) => {
            const current = guidanceFlow.answers[questionId] || {};
            guidanceFlow.answers[questionId] = {
                ...current,
                selectedOptionId: optionId
            };
        };
        const selectGuidanceCustomOption = (questionId) => selectGuidanceOption(questionId, 'custom');
        const setGuidanceCustomText = (questionId, value) => {
            const current = guidanceFlow.answers[questionId] || {};
            guidanceFlow.answers[questionId] = {
                ...current,
                selectedOptionId: 'custom',
                customText: value
            };
        };

        const prepareGuidanceQuestions = async () => {
            clearLastError();
            appState.value = 'GENERATING';
            systemMessage.value = 'Preparing three high-leverage questions...';
            thoughtLog.value = [{ text: 'Finding the choices most likely to make this sound specific...', isThought: true }];
            guidanceFlow.isPreparing = true;
            diagnostics.info('guidance.questions.start', {
                homeworkType: homeworkType.value,
                careerPresent: !!assignmentMeta.career?.trim(),
                requestedPages: assignmentMeta.lengthMode === 'pages' ? assignmentMeta.requestedPages : null,
                targetWords: assignmentMeta.targetWords
            });

            try {
                const result = await callGeminiStructuredStream(
                    buildGuidanceQuestionsPrompt(),
                    guidanceQuestionsSchema,
                    {
                        feature: 'guidance_questions',
                        preferredModel: FALLBACK_GEMINI_MODEL,
                        allowFallback: false,
                        thinkingLevel: 'high',
                        retryStage: 'guidance questions'
                    }
                );

                const questions = Array.isArray(result?.questions) ? result.questions.slice(0, 3) : [];
                if (questions.length === 0) throw new Error('No guidance questions were generated.');

                guidanceFlow.questions = questions;
                guidanceFlow.answers = {};
                questions.forEach((question) => {
                    const recommended = question.options.find(option => option.id === question.recommendedOptionId) || question.options[0];
                    guidanceFlow.answers[question.id] = {
                        selectedOptionId: recommended?.id || '',
                        customText: ''
                    };
                });

                diagnostics.info('guidance.questions.complete', {
                    questionCount: guidanceFlow.questions.length
                });

                appState.value = 'QUESTION_GUIDANCE';
            } catch (error) {
                diagnostics.error('guidance.questions.failed', {
                    message: error?.message || String(error),
                    requestId: error?.requestId || null
                });
                setUserVisibleError(error, 'guidance questions');
                appState.value = 'DASHBOARD';
            } finally {
                guidanceFlow.isPreparing = false;
            }
        };

        const acceptGuidanceAndGenerate = async () => {
            guidanceFlow.wasShownForCurrentDraft = true;
            await runHomeworkGeneration();
        };

        // --- API Helpers ---

        const getApiKey = () => {
            const key = localStorage.getItem('scriptoria_api_key');
            if (!key) throw new Error('No API Key found');
            return key;
        };

        // 1. Structured Output Call with Streaming
        const callGeminiStructuredStream = async (userPrompt, schema, options = {}) => {
            const apiKey = getApiKey();
            const feature = options.feature || 'style_analysis';
            const streamType = options.streamType || 'structured';
            const thinkingLevel = options.thinkingLevel || 'high';
            const files = options.files || [];
            const parts = [{ text: userPrompt }];

            files.forEach(file => {
                parts.push({
                    inline_data: {
                        mime_type: file.mimeType,
                        data: file.data.split(',')[1]
                    }
                });
            });

            const payload = {
                contents: [{ role: 'user', parts }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseJsonSchema: schema,
                    temperature: 1.0,
                    topP: 1.0,
                    maxOutputTokens: 60000,
                    thinkingConfig: {
                        includeThoughts: true,
                        thinkingLevel
                    }
                }
            };

            const attemptModelRequest = async (model) => {
                let jsonAccumulator = '';
                const { response, requestId } = await fetchWithDiagnostics(buildGeminiStreamUrl(apiKey, model), payload, {
                    feature,
                    streamType,
                    model,
                    fileCount: files.length
                });

                const streamSummary = await readSseStream(response, (data) => {
                    const parts = data.candidates?.[0]?.content?.parts || [];

                    for (const part of parts) {
                        if (part.thoughtSignature) {
                            lastSignature.value = part.thoughtSignature;
                        }

                        if (part.thought) {
                            if (thoughtLog.value.length === 0 || !thoughtLog.value[thoughtLog.value.length - 1].isThought) {
                                thoughtLog.value.push({ text: part.text || '', isThought: true });
                            } else {
                                thoughtLog.value[thoughtLog.value.length - 1].text += part.text || '';
                            }
                        } else if (part.text) {
                            jsonAccumulator += part.text;
                        }
                    }
                }, { requestId, feature, model });

                diagnostics.info('structured.stream_complete', {
                    requestId,
                    model,
                    feature,
                    eventCount: streamSummary.eventCount,
                    jsonLength: jsonAccumulator.length
                });

                try {
                    return jsonAccumulator ? JSON.parse(jsonAccumulator) : null;
                } catch (parseError) {
                    diagnostics.error('structured.json_parse_failed', {
                        requestId,
                        model,
                        feature,
                        message: parseError?.message || String(parseError),
                        jsonPreview: jsonAccumulator
                    });
                    const error = new Error('Structured response parse failed.');
                    error.requestId = requestId;
                    error.errorStage = 'finalize';
                    throw error;
                }
            };

            const initialModel = options.preferredModel || PRIMARY_GEMINI_MODEL;
            const fallbackModel = options.fallbackModel || FALLBACK_GEMINI_MODEL;
            const allowFallback = options.allowFallback !== false && initialModel !== fallbackModel;
            const retryStage = options.retryStage || feature.replace(/_/g, ' ');

            try {
                return await attemptModelRequest(initialModel);
            } catch (primaryError) {
                const canFallbackForStructuredParse = allowFallback && primaryError?.errorStage === 'finalize';
                if (!isModelAvailabilityError(primaryError) && !canFallbackForStructuredParse) throw primaryError;

                if (allowFallback) {
                    diagnostics.warn('model.fallback_triggered', {
                        feature,
                        fromModel: initialModel,
                        toModel: fallbackModel,
                        reason: primaryError.message,
                        errorStage: primaryError.errorStage || null
                    });

                    try {
                        return await attemptModelRequest(fallbackModel);
                    } catch (fallbackError) {
                        if (!isModelAvailabilityError(fallbackError)) throw fallbackError;

                        diagnostics.warn('model.retry_scheduled', {
                            feature,
                            model: fallbackModel,
                            delayMs: FALLBACK_RETRY_DELAY_MS,
                            reason: fallbackError.message
                        });
                        systemMessage.value = 'Google API is under high demand. Retrying automatically in 30 seconds...';
                        lastError.value = {
                            supportId: generateDiagnosticId('support'),
                            stage: retryStage,
                            message: createRetryScheduledError(fallbackError).message,
                            requestId: fallbackError.requestId || null,
                            status: fallbackError.status || null,
                            statusText: fallbackError.statusText || null
                        };
                        await wait(FALLBACK_RETRY_DELAY_MS);
                        clearLastError();
                        systemMessage.value = 'Retrying with fallback model...';
                        return await attemptModelRequest(fallbackModel);
                    }
                }

                diagnostics.warn('model.retry_scheduled', {
                    feature,
                    model: initialModel,
                    delayMs: FALLBACK_RETRY_DELAY_MS,
                    reason: primaryError.message
                });
                systemMessage.value = 'Google API is under high demand. Retrying automatically in 30 seconds...';
                lastError.value = {
                    supportId: generateDiagnosticId('support'),
                    stage: retryStage,
                    message: createRetryScheduledError(primaryError).message,
                    requestId: primaryError.requestId || null,
                    status: primaryError.status || null,
                    statusText: primaryError.statusText || null
                };
                await wait(FALLBACK_RETRY_DELAY_MS);
                clearLastError();
                systemMessage.value = 'Retrying with stable Flash-Lite model...';
                return await attemptModelRequest(initialModel);
            }
        };

        // 2. Streaming Call with Thinking
        const callGeminiStream = async (userPrompt, systemPrompt, files = [], history = null, options = {}) => {
            const apiKey = getApiKey();
            const feature = options.feature || (history ? 'humanize' : 'homework');
            const retryStage = options.retryStage || (history ? 'humanization' : 'homework generation');

            let contents;
            if (history) {
                contents = history;
            } else {
                contents = [{ role: 'user', parts: [{ text: userPrompt }] }];

                // Handle Files (Inline)
                if (files.length > 0) {
                    files.forEach(file => {
                        const base64Data = file.data.split(',')[1];
                        contents[0].parts.push({
                            inline_data: { mime_type: file.mimeType, data: base64Data }
                        });
                    });
                }
            }

            const payload = {
                contents: contents,
                system_instruction: { parts: [{ text: systemPrompt }] },
                generationConfig: {
                    temperature: 1.0,
                    topP: 1.0,
                    maxOutputTokens: 60000,
                    thinkingConfig: {
                        includeThoughts: true,
                        thinkingLevel: "high"
                    }
                }
            };

            const attemptModelRequest = async (model) => {
                const { response, requestId } = await fetchWithDiagnostics(buildGeminiStreamUrl(apiKey, model), payload, {
                    feature,
                    streamType: 'text',
                    fileCount: files.length,
                    usingHistory: !!history,
                    model,
                    ...(options.context || {})
                });

                let textChunkCount = 0;
                let thoughtChunkCount = 0;
                const streamSummary = await readSseStream(response, (data) => {
                    const parts = data.candidates?.[0]?.content?.parts || [];

                    for (const part of parts) {
                        if (part.thoughtSignature) {
                            lastSignature.value = part.thoughtSignature;
                        }

                        if (part.thought) {
                            thoughtChunkCount += 1;
                            if (thoughtLog.value.length === 0 || !thoughtLog.value[thoughtLog.value.length - 1].isThought) {
                                thoughtLog.value.push({ text: part.text || '', isThought: true });
                            } else {
                                thoughtLog.value[thoughtLog.value.length - 1].text += part.text || '';
                            }
                        } else if (part.text) {
                            textChunkCount += 1;
                            generatedContent.value += part.text;
                        }
                    }
                }, {
                    requestId,
                    feature,
                    model,
                    ...(options.context || {})
                });

                const result = {
                    requestId,
                    streamEventCount: streamSummary.eventCount,
                    textChunkCount,
                    thoughtChunkCount,
                    model
                };

                if (options.requireVisibleOutput && !generatedContent.value.trim()) {
                    diagnostics.warn('stream.empty_output', {
                        requestId,
                        feature,
                        model,
                        streamEventCount: streamSummary.eventCount,
                        textChunkCount,
                        thoughtChunkCount,
                        ...(options.context || {})
                    });
                    const error = new Error('Gemini completed the request without returning visible content.');
                    error.requestId = requestId;
                    error.errorStage = 'empty_output';
                    error.retryableEmptyOutput = true;
                    error.model = model;
                    throw error;
                }

                return result;
            };

            const initialModel = options.preferredModel || PRIMARY_GEMINI_MODEL;
            const fallbackModel = options.fallbackModel || FALLBACK_GEMINI_MODEL;
            const allowFallback = options.allowFallback !== false && initialModel !== fallbackModel;
            const isRetryableStreamFailure = (error) =>
                isModelAvailabilityError(error) || error?.retryableEmptyOutput === true;
            const resetEmptyAttempt = (error) => {
                if (!error?.retryableEmptyOutput) return;
                generatedContent.value = '';
                thoughtLog.value = [];
                lastSignature.value = null;
            };

            try {
                return await attemptModelRequest(initialModel);
            } catch (primaryError) {
                if (!isRetryableStreamFailure(primaryError)) throw primaryError;
                resetEmptyAttempt(primaryError);

                if (!allowFallback) {
                    diagnostics.warn('model.retry_scheduled', {
                        feature,
                        model: initialModel,
                        delayMs: FALLBACK_RETRY_DELAY_MS,
                        reason: primaryError.message
                    });
                    systemMessage.value = 'Google API is under high demand. Retrying automatically in 30 seconds...';
                    lastError.value = {
                        supportId: generateDiagnosticId('support'),
                        stage: retryStage,
                        message: createRetryScheduledError(primaryError).message,
                        requestId: primaryError.requestId || null,
                        status: primaryError.status || null,
                        statusText: primaryError.statusText || null
                    };
                    await wait(FALLBACK_RETRY_DELAY_MS);
                    clearLastError();
                    systemMessage.value = 'Retrying with stable Flash-Lite model...';
                    return await attemptModelRequest(initialModel);
                }

                diagnostics.warn('model.fallback_triggered', {
                    feature,
                    fromModel: initialModel,
                    toModel: fallbackModel,
                    reason: primaryError.message
                });

                try {
                    return await attemptModelRequest(fallbackModel);
                } catch (fallbackError) {
                    if (!isRetryableStreamFailure(fallbackError)) throw fallbackError;
                    resetEmptyAttempt(fallbackError);

                    diagnostics.warn('model.retry_scheduled', {
                        feature,
                        model: fallbackModel,
                        delayMs: FALLBACK_RETRY_DELAY_MS,
                        reason: fallbackError.message
                    });
                    systemMessage.value = 'Google API is under high demand. Retrying automatically in 30 seconds...';
                    lastError.value = {
                        supportId: generateDiagnosticId('support'),
                        stage: retryStage,
                        message: createRetryScheduledError(fallbackError).message,
                        requestId: fallbackError.requestId || null,
                        status: fallbackError.status || null,
                        statusText: fallbackError.statusText || null
                    };
                    await wait(FALLBACK_RETRY_DELAY_MS);
                    clearLastError();
                    systemMessage.value = 'Retrying with fallback model...';
                    return await attemptModelRequest(fallbackModel);
                }
            }
        };

        const finishStyleSetup = async () => {
            // Save raw answers just in case
            localStorage.setItem('scriptoria_raw_style', JSON.stringify(styleForm));

            // Analyze Style
            appState.value = 'GENERATING';
            systemMessage.value = 'Deconstructing Neural Patterns...';
            thoughtLog.value = [{ text: 'Initializing Style Analysis Protocol...', isThought: true }];
            clearLastError();

            try {
                const prompt = PROMPTS.STYLE_ANALYSIS
                    .replace('{{VIBE}}', styleForm.vibe)
                    .replace('{{ARGUMENT}}', styleForm.argument)
                    .replace('{{HOWTO}}', styleForm.howto)
                    .replace('{{CANCEL}}', styleForm.cancel);

                // Use Structured Output with Streaming
                const analysisResult = await callGeminiStructuredStream(prompt, styleAnalysisSchema);

                if (analysisResult) {
                    // Save results
                    localStorage.setItem('scriptoria_style_analysis', JSON.stringify(analysisResult.style_profile));
                    localStorage.setItem('scriptoria_style_profile', analysisResult.system_prompt);

                    systemMessage.value = 'Generating validation previews...';
                    await prepareStyleValidationPreviews();
                } else {
                    throw new Error('Failed to generate style profile');
                }
            } catch (e) {
                diagnostics.error('style_setup.failed', {
                    message: e?.message || String(e),
                    requestId: e?.requestId || null
                });
                setUserVisibleError(e, 'style setup');
                styleReview.isPreparing = false;
                appState.value = 'SETUP_STYLE'; // Go back
            }
        };

        const requestHomeworkGeneration = async () => {
            if (!homeworkForm.topic.trim()) {
                triggerShake();
                return;
            }

            syncTargetWords();
            if (!assignmentMeta.career?.trim()) {
                pendingCareerNextState.value = 'DASHBOARD';
                appState.value = 'CAREER_SETUP';
                return;
            }
            saveAssignmentCareer();

            if (shouldShowGuidanceQuestions()) {
                await prepareGuidanceQuestions();
                return;
            }

            await runHomeworkGeneration();
        };

        const generateHomework = requestHomeworkGeneration;

        const runHomeworkGeneration = async () => {
            if (!homeworkForm.topic.trim()) {
                triggerShake();
                return;
            }

            hasGenerationAttempted.value = true;
            generationAttemptCount.value += 1;
            appState.value = 'GENERATING';
            systemMessage.value = 'The Core is thinking...';
            generatedContent.value = '';
            thoughtLog.value = []; // Reset thoughts
            lastSignature.value = null; // Reset signature for new generation
            clearLastError();
            lastGenerationMetrics.value = null;
            const attemptNumber = generationAttemptCount.value;
            const attemptStartedAt = performance.now();

            diagnostics.info('generation.start', {
                attemptNumber,
                homeworkType: homeworkType.value,
                fileCount: homeworkForm.files.length,
                careerPresent: !!assignmentMeta.career?.trim(),
                lengthMode: assignmentMeta.lengthMode,
                targetWords: assignmentMeta.targetWords,
                citationRequired: !!assignmentMeta.citationRequired,
                guidanceQuestionCount: guidanceFlow.questions.length
            });

            if (!validateSupportedFiles(homeworkForm.files, 'homework generation')) {
                pushGenerationAttempt({
                    attemptNumber,
                    status: 'blocked',
                    reason: 'unsupported_file_type',
                    errorStage: 'upload'
                });
                appState.value = 'DASHBOARD';
                return;
            }

            try {
                const styleProfile = localStorage.getItem('scriptoria_style_profile') || 'Standard academic tone.';
                const systemPrompt = PROMPTS.SYSTEM.replace('{{STYLE_PROFILE}}', styleProfile);
                const userPrompt = buildUserPrompt();

                // Use Streaming with Thinking
                const result = await callGeminiStream(userPrompt, systemPrompt, homeworkForm.files, null, {
                    feature: 'assignment_generation',
                    retryStage: 'assignment generation',
                    requireVisibleOutput: true
                });
                const durationMs = Math.round(performance.now() - attemptStartedAt);
                const outputLength = generatedContent.value.length;
                const hadVisibleContent = outputLength > 0;
                const hadPreviousFailuresBeforeSuccess = recentGenerationAttempts.value.some(attempt =>
                    attempt.status === 'failed' || attempt.status === 'blocked'
                );

                // Add to history only if successful
                addToHistory(homeworkForm.topic);
                lastSuccessfulGenerationAt.value = new Date().toISOString();
                lastGenerationMetrics.value = {
                    attemptNumber,
                    model: result.model,
                    durationMs,
                    outputLength,
                    hadVisibleContent,
                    textChunkCount: result.textChunkCount,
                    thoughtChunkCount: result.thoughtChunkCount,
                    streamEventCount: result.streamEventCount,
                    hadPreviousFailuresBeforeSuccess
                };
                pushGenerationAttempt({
                    attemptNumber,
                    status: 'success',
                    requestId: result.requestId,
                    model: result.model,
                    durationMs,
                    outputLength,
                    hadVisibleContent,
                    hadPreviousFailuresBeforeSuccess
                });
                diagnostics.info('generation.complete', {
                    attemptNumber,
                    requestId: result.requestId,
                    model: result.model,
                    durationMs,
                    outputLength,
                    hadVisibleContent,
                    textChunkCount: result.textChunkCount,
                    thoughtChunkCount: result.thoughtChunkCount,
                    streamEventCount: result.streamEventCount,
                    hadPreviousFailuresBeforeSuccess
                });
                appState.value = 'RESULT';

                // Render math after DOM is updated with new state
                if (homeworkType.value === 'math') {
                    renderMath();
                }
                appState.value = 'RESULT';

            } catch (e) {
                pushGenerationAttempt({
                    attemptNumber,
                    status: 'failed',
                    requestId: e?.requestId || null,
                    statusCode: e?.status || null,
                    message: e?.message || String(e),
                    errorStage: e?.errorStage || 'fetch',
                    durationMs: Math.round(performance.now() - attemptStartedAt)
                });
                diagnostics.error('homework_generation.failed', {
                    attemptNumber,
                    errorStage: e?.errorStage || 'fetch',
                    message: e?.message || String(e),
                    requestId: e?.requestId || null
                });
                setUserVisibleError(e, 'homework generation');
                appState.value = 'DASHBOARD';
            }
        };

        const humanizeContent = async () => {
            if (!generatedContent.value) return;

            const originalContent = generatedContent.value;
            appState.value = 'GENERATING';
            systemMessage.value = 'Infusing Human Imperfections...';
            generatedContent.value = '';
            thoughtLog.value = [];
            clearLastError();

            try {
                const styleProfile = localStorage.getItem('scriptoria_style_profile') || 'Standard academic tone.';
                const prompt = PROMPTS.HUMANIZE
                    .replace('{{STYLE_PROFILE}}', styleProfile)
                    .replace('{{CONTENT}}', originalContent);

                // Construct history for continuity if signature exists
                let history = null;
                if (lastSignature.value) {
                    history = [
                        { role: 'user', parts: [{ text: homeworkForm.topic }] }, // Simulate previous turn
                        { role: 'model', parts: [{ text: originalContent, thoughtSignature: lastSignature.value }] },
                        { role: 'user', parts: [{ text: prompt }] }
                    ];
                }

                // Use Streaming
                await callGeminiStream(prompt, "You are a professional editor.", [], history);

                // Update history with new version
                addToHistory(homeworkForm.topic, true);
                appState.value = 'RESULT';

                // Render math after DOM is updated
                if (homeworkType.value === 'math') {
                    renderMath();
                }
                appState.value = 'RESULT';

            } catch (e) {
                diagnostics.error('humanize.failed', {
                    message: e?.message || String(e),
                    requestId: e?.requestId || null
                });
                setUserVisibleError(e, 'humanization');
                generatedContent.value = originalContent; // Revert
                appState.value = 'RESULT';
            }
        };

        const addToHistory = (topic, isHumanized = false) => {
            const newItem = {
                topic: topic + (isHumanized ? ' (Humanized)' : ''),
                subject: homeworkForm.subject,
                taskType: homeworkForm.taskType,
                details: homeworkForm.details,
                content: generatedContent.value, // Save content
                signature: lastSignature.value, // Save signature
                timestamp: new Date().toLocaleDateString()
            };
            history.value.unshift(newItem);
            if (history.value.length > 10) history.value.pop();
            localStorage.setItem('scriptoria_history', JSON.stringify(history.value));
        };

        const loadHistory = () => {
            const stored = localStorage.getItem('scriptoria_history');
            if (stored) {
                history.value = JSON.parse(stored);
            }
        };

        const loadHistoryItem = (item) => {
            homeworkForm.topic = item.topic.replace(' (Humanized)', ''); // Remove label
            homeworkForm.subject = item.subject;
            homeworkForm.taskType = item.taskType;
            homeworkForm.details = item.details;

            // Load the saved content if it exists
            if (item.content) {
                generatedContent.value = item.content;
                lastSignature.value = item.signature || null;
                appState.value = 'RESULT';

                if (homeworkType.value === 'math') {
                    renderMath();
                }
            }

            if (window.innerWidth < 768) isSidebarOpen.value = false; // Close sidebar on mobile
        };

        const renderMath = () => {
            nextTick(() => {
                setTimeout(() => {
                    const mathElement = document.getElementById('math-output');

                    if (mathElement && window.renderMathInElement) {
                        window.renderMathInElement(mathElement, {
                            delimiters: [
                                {left: '$$', right: '$$', display: true},
                                {left: '$', right: '$', display: false},
                                {left: '\\(', right: '\\)', display: false},
                                {left: '\\[', right: '\\]', display: true}
                            ],
                            throwOnError: false
                        });
                    } else if (!mathElement) {
                        setTimeout(renderMath, 200);
                    } else {
                        console.warn('KaTeX auto-render library is missing.');
                    }
                }, 600);
            });
        };

        const renderStyleReviewMath = () => {
            nextTick(() => {
                setTimeout(() => {
                    const mathElement = document.getElementById('style-review-math-output');

                    if (mathElement && window.renderMathInElement) {
                        window.renderMathInElement(mathElement, {
                            delimiters: [
                                {left: '$$', right: '$$', display: true},
                                {left: '$', right: '$', display: false},
                                {left: '\\(', right: '\\)', display: false},
                                {left: '\\[', right: '\\]', display: true}
                            ],
                            throwOnError: false
                        });
                    }
                }, 150);
            });
        };

        const copyToClipboard = async () => {
            try {
                await navigator.clipboard.writeText(generatedContent.value);
                copyBtnText.value = 'Copied!';
                setTimeout(() => copyBtnText.value = 'Copy', 2000);
            } catch (err) {
                console.error('Failed to copy', err);
            }
        };

        const addFilesToCollection = (event, targetCollection, diagnosticFeature = 'homework') => {
            const files = event.target.files || event.dataTransfer.files;
            if (!files || files.length === 0) return;

            Array.from(files).forEach(file => {
                const mimeType = resolveSupportedMimeType(file);
                if (!mimeType) {
                    const error = new Error(`Unsupported file type: ${file.name}. Use PNG, JPG, WEBP, HEIC, HEIF, PDF, or TXT.`);
                    diagnostics.warn('file.unsupported', {
                        fileName: file.name,
                        fileType: file.type || 'unknown'
                    });
                    setUserVisibleError(error, 'file upload');
                    return;
                }

                const reader = new FileReader();
                reader.onload = (e) => {
                    targetCollection.push({
                        name: file.name,
                        type: file.type,
                        mimeType,
                        size: file.size || null,
                        data: e.target.result // Base64
                    });
                    diagnostics.info('file.uploaded', {
                        feature: diagnosticFeature,
                        fileName: file.name,
                        mimeType,
                        size: file.size || null
                    });
                };
                reader.readAsDataURL(file);
            });

            if (event.target?.value !== undefined) {
                event.target.value = '';
            }
        };

        const handleFileUpload = (event) => {
            addFilesToCollection(event, homeworkForm.files, 'homework');
        };

        const handleDecoderFileUpload = (event) => {
            addFilesToCollection(event, decoderForm.files, 'assignment_decoder');
        };

        const removeFile = (index) => {
            const removedFile = homeworkForm.files[index];
            homeworkForm.files.splice(index, 1);
            diagnostics.info('file.removed', {
                feature: 'homework',
                fileName: removedFile?.name || 'unknown'
            });
        };

        const removeDecoderFile = (index) => {
            const removedFile = decoderForm.files[index];
            decoderForm.files.splice(index, 1);
            diagnostics.info('file.removed', {
                feature: 'assignment_decoder',
                fileName: removedFile?.name || 'unknown'
            });
        };

        const toggleHomeworkType = (type) => {
            homeworkType.value = type;
        };

        // Ref for thought log container
        const thoughtLogContainer = ref(null);

        // Auto-scroll thought log whenever it updates
        watch(thoughtLog, () => {
            nextTick(() => {
                if (thoughtLogContainer.value) {
                    thoughtLogContainer.value.scrollTop = thoughtLogContainer.value.scrollHeight;
                }
            });
        }, { deep: true });

        watch([appState, () => styleReview.activePreviewId, activeStylePreviewContent], () => {
            if (appState.value === 'STYLE_REVIEW' && activeStylePreview.value.type === 'math' && activeStylePreviewContent.value) {
                renderStyleReviewMath();
            }
        });

        watch(() => [
            homeworkForm.topic,
            homeworkForm.subject,
            homeworkForm.taskType,
            homeworkForm.details,
            homeworkType.value,
            assignmentMeta.career,
            assignmentMeta.lengthMode,
            assignmentMeta.requestedPages,
            assignmentMeta.targetWords,
            assignmentMeta.citationRequired,
            assignmentMeta.citationStyle,
            assignmentMeta.citationInstructions
        ], () => {
            if (appState.value === 'DASHBOARD') {
                resetGuidanceForDraft();
            }
        });

        watch(() => [assignmentMeta.lengthMode, assignmentMeta.requestedPages], () => {
            if (assignmentMeta.lengthMode === 'pages') {
                syncTargetWords();
            }
        });

        // --- Lifecycle ---
        onMounted(() => {
            installGlobalDiagnostics();
            diagnostics.info('app.mounted', {
                appVersion: APP_VERSION
            });
            console.log('Scriptoria: System Online');

            setTimeout(() => {
                appState.value = 'LOGIN';
            }, 1000);
        });

        return {
            appState,
            systemMessage,
            form,
            errorMsg,
            isShake,
            isTermsModalOpen,
            lastError,
            hasGenerationAttempted,
            decoderNotice,
            generatedContent,
            thoughtLog,
            thoughtLogContainer, // For auto-scroll
            copyBtnText,
            checkLogin,
            openTermsModal,
            closeTermsModal,
            saveKey,
            // Style Interview
            interviewStep,
            styleForm,
            questions,
            currentQuestion,
            styleValidationCases,
            styleReview,
            activeStylePreview,
            activeStylePreviewContent,
            nextStep,
            prevStep,
            selectStylePreview,
            acceptStyleAndContinue,
            retryStyleTraining,
            // College workflow
            careerForm,
            assignmentMeta,
            decoderForm,
            guidanceFlow,
            citationOptions,
            guidanceQuestionsEnabled,
            saveCareerAndContinue,
            saveAssignmentCareer,
            setRequestedPages,
            adjustRequestedPages,
            goToManualEntry,
            openAssignmentDecoder,
            decodeAssignment,
            handleDecoderFileUpload,
            removeDecoderFile,
            selectGuidanceOption,
            selectGuidanceCustomOption,
            setGuidanceCustomText,
            acceptGuidanceAndGenerate,
            // Dashboard
            homeworkType,
            homeworkForm,
            history,
            isSidebarOpen,
            toggleSidebar,
            toggleHomeworkType,
            handleFileUpload,
            removeFile,
            generateHomework,
            humanizeContent,
            loadHistoryItem,
            copyToClipboard,
            clearLastError,
            downloadDiagnosticReport,
            lastSignature,
            renderMath
        };
    }
});

app.mount('#app');
