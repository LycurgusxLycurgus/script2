const { createApp, ref, reactive, computed, onMounted, nextTick, watch } = Vue;

const app = createApp({
    setup() {
        // --- State ---
        const appState = ref('INIT'); // INIT, LOGIN, SETUP_KEY, SETUP_STYLE, STYLE_REVIEW, DASHBOARD, GENERATING, RESULT
        const systemMessage = ref('Initializing Obsidian Core...');
        const errorMsg = ref('');
        const isShake = ref(false);
        const generatedContent = ref('');
        const thoughtLog = ref([]); // For Thinking Stream
        const copyBtnText = ref('Copy');
        const lastSignature = ref(null);

        // --- Data: Auth ---
        const credentials = Array.isArray(window.SCRIPTORIA_USERS) ? window.SCRIPTORIA_USERS : [];

        const form = reactive({
            username: '',
            password: '',
            apiKey: '',
            acceptTerms: false
        });

        const isTermsModalOpen = ref(false);

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
                label: 'Text Homework Preview',
                topic: 'Do school uniforms improve student outcomes?',
                subject: 'Education',
                taskType: 'Argumentative Response',
                details: 'Take one clear position, include one counterargument, and end with a practical conclusion.'
            },
            {
                id: 'math_preview',
                type: 'math',
                label: 'Math Homework Preview',
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

        // --- Methods ---

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
                appState.value = 'DASHBOARD';
                loadHistory();
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
            return userPromptTemplate
                .replace('{{TASK_TYPE}}', previewCase.taskType || 'General Task')
                .replace('{{TOPIC}}', previewCase.topic)
                .replace('{{SUBJECT}}', previewCase.subject || 'General')
                .replace('{{DETAILS}}', previewCase.details || 'None');
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
                generatedContent.value = '';
                thoughtLog.value = [];
                systemMessage.value = `Generating validation previews (${index + 1}/${styleValidationCases.length})...`;
                const userPrompt = buildPreviewUserPrompt(previewCase);
                await callGeminiStream(userPrompt, systemPrompt, []);
                styleReview.previews[previewCase.id] = generatedContent.value;
            }

            styleReview.isPreparing = false;
            appState.value = 'STYLE_REVIEW';
        };

        const selectStylePreview = (previewId) => {
            if (!styleReview.previews[previewId]) return;
            styleReview.activePreviewId = previewId;
        };

        const acceptStyleAndContinue = () => {
            appState.value = 'DASHBOARD';
            loadHistory();
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

        // --- API Helpers ---

        const getApiKey = () => {
            const key = localStorage.getItem('scriptoria_api_key');
            if (!key) throw new Error('No API Key found');
            return key;
        };

        // 1. Structured Output Call with Streaming (Gemini 2.5 Pro for Style Analysis)
        const callGeminiStructuredStream = async (userPrompt, schema) => {
            const apiKey = getApiKey();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse&key=${apiKey}`;

            const payload = {
                contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseJsonSchema: schema,
                    temperature: 1.0,
                    topP: 1.0,
                    maxOutputTokens: 60000,
                    thinkingConfig: {
                        includeThoughts: true,
                        thinkingLevel: "high"
                    }
                }
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error('Stream Error');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let jsonAccumulator = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.slice(6);
                        if (jsonStr === '[DONE]') continue;
                        try {
                            const data = JSON.parse(jsonStr);
                            const parts = data.candidates?.[0]?.content?.parts || [];

                            for (const part of parts) {
                                if (part.thoughtSignature) {
                                    lastSignature.value = part.thoughtSignature;
                                }

                                if (part.thought) {
                                    // Append to thought log
                                    if (thoughtLog.value.length === 0 || !thoughtLog.value[thoughtLog.value.length - 1].isThought) {
                                        thoughtLog.value.push({ text: part.text, isThought: true });
                                    } else {
                                        thoughtLog.value[thoughtLog.value.length - 1].text += part.text;
                                    }
                                } else if (part.text) {
                                    // Accumulate JSON chunks
                                    jsonAccumulator += part.text;
                                }
                            }
                        } catch (e) {
                            console.warn('Parse error', e);
                        }
                    }
                }
            }

            return jsonAccumulator ? JSON.parse(jsonAccumulator) : null;
        };

        // 2. Streaming Call with Thinking
        const callGeminiStream = async (userPrompt, systemPrompt, files = [], history = null) => {
            const apiKey = getApiKey();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse&key=${apiKey}`;

            let contents;
            if (history) {
                contents = history;
            } else {
                contents = [{ role: 'user', parts: [{ text: userPrompt }] }];

                // Handle Files (Inline)
                if (files.length > 0) {
                    files.forEach(file => {
                        const base64Data = file.data.split(',')[1];
                        const mimeType = file.data.split(';')[0].split(':')[1];
                        contents[0].parts.push({
                            inline_data: { mime_type: mimeType, data: base64Data }
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
                        thinkingLevel: "medium"
                    }
                }
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error('Stream Error');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.slice(6);
                        if (jsonStr === '[DONE]') continue;
                        try {
                            const data = JSON.parse(jsonStr);
                            const parts = data.candidates?.[0]?.content?.parts || [];

                            for (const part of parts) {
                                if (part.thoughtSignature) {
                                    lastSignature.value = part.thoughtSignature;
                                }

                                if (part.thought) {
                                    // Append to thought log
                                    if (thoughtLog.value.length === 0 || !thoughtLog.value[thoughtLog.value.length - 1].isThought) {
                                        thoughtLog.value.push({ text: part.text, isThought: true });
                                    } else {
                                        thoughtLog.value[thoughtLog.value.length - 1].text += part.text;
                                    }
                                } else if (part.text) {
                                    // Real content
                                    generatedContent.value += part.text;
                                }
                            }
                        } catch (e) {
                            console.warn('Parse error', e);
                        }
                    }
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
                console.error(e);
                alert('Connection Severed. Please check your API Key and try again.');
                styleReview.isPreparing = false;
                appState.value = 'SETUP_STYLE'; // Go back
            }
        };

        const generateHomework = async () => {
            if (!homeworkForm.topic.trim()) {
                triggerShake();
                return;
            }

            appState.value = 'GENERATING';
            systemMessage.value = 'The Core is thinking...';
            generatedContent.value = '';
            thoughtLog.value = []; // Reset thoughts
            lastSignature.value = null; // Reset signature for new generation

            try {
                const styleProfile = localStorage.getItem('scriptoria_style_profile') || 'Standard academic tone.';
                const systemPrompt = PROMPTS.SYSTEM.replace('{{STYLE_PROFILE}}', styleProfile);

                let userPromptTemplate = homeworkType.value === 'math' ? PROMPTS.HOMEWORK_MATH : PROMPTS.HOMEWORK_TEXT;
                const userPrompt = userPromptTemplate
                    .replace('{{TASK_TYPE}}', homeworkForm.taskType || 'General Task')
                    .replace('{{TOPIC}}', homeworkForm.topic)
                    .replace('{{SUBJECT}}', homeworkForm.subject || 'General')
                    .replace('{{DETAILS}}', homeworkForm.details || 'None');

                // Use Streaming with Thinking
                await callGeminiStream(userPrompt, systemPrompt, homeworkForm.files);

                // Add to history only if successful
                addToHistory(homeworkForm.topic);
                appState.value = 'RESULT';

                // Render math after DOM is updated with new state
                if (homeworkType.value === 'math') {
                    renderMath();
                }
                appState.value = 'RESULT';

            } catch (e) {
                console.error(e);
                alert('Generation Failed: ' + e.message);
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
                console.error(e);
                alert('Humanization Failed: ' + e.message);
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

        const handleFileUpload = (event) => {
            const files = event.target.files || event.dataTransfer.files;
            if (!files || files.length === 0) return;

            Array.from(files).forEach(file => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    homeworkForm.files.push({
                        name: file.name,
                        type: file.type,
                        data: e.target.result // Base64
                    });
                };
                reader.readAsDataURL(file);
            });
        };

        const removeFile = (index) => {
            homeworkForm.files.splice(index, 1);
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

        // --- Lifecycle ---
        onMounted(() => {
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
            lastSignature,
            renderMath
        };
    }
});

app.mount('#app');
