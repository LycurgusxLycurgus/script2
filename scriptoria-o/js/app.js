const { createApp, ref, reactive, computed, onMounted } = Vue;

const app = createApp({
    setup() {
        // --- State ---
        const appState = ref('INIT'); // INIT, LOGIN, SETUP_KEY, SETUP_STYLE, DASHBOARD, GENERATING, RESULT
        const systemMessage = ref('Initializing Obsidian Core...');
        const errorMsg = ref('');
        const isShake = ref(false);
        const generatedContent = ref('');
        const thoughtLog = ref([]); // For Thinking Stream
        const copyBtnText = ref('Copy');

        // --- Data: Auth ---
        const credentials = [
            { u: 'admin', p: 'scriptoria' },
            { u: 'scholar', p: '1234' },
            { u: 'guest', p: 'guest' }
        ];

        const form = reactive({
            username: '',
            password: '',
            apiKey: ''
        });

        // --- Data: Style Interview ---
        const interviewStep = ref(0);
        const styleForm = reactive({
            vibe: '',
            argument: '',
            howto: '',
            cancel: ''
        });

        const questions = [
            {
                id: 'vibe',
                label: 'The "Vibe" Check',
                question: 'Describe the room you\'re in right now.',
                subtitle: 'Don\'t just list objects—describe what it feels like to be there.',
                placeholder: 'Write 4-5 lines naturally, as if texting a friend...',
                model: 'vibe'
            },
            {
                id: 'argument',
                label: 'The Silly Argument',
                question: 'Pick a playful opinion and defend it.',
                subtitle: 'e.g., "Hot dogs are sandwiches" or "Winter > Summer"',
                placeholder: 'Explain why you\'re right in 4-5 lines...',
                model: 'argument'
            },
            {
                id: 'howto',
                label: 'The Quick How-To',
                question: 'Explain something simple to a beginner.',
                subtitle: 'Like making cereal, tying shoes, or posting on Instagram.',
                placeholder: 'Write clear instructions in 4-5 lines...',
                model: 'howto'
            },
            {
                id: 'cancel',
                label: 'The "I Can\'t Make It" Message',
                question: 'You have to cancel plans last minute.',
                subtitle: 'Write the text you\'d send. Be honest—excuse, apologize, or direct?',
                placeholder: 'Write your message in 4-5 lines...',
                model: 'cancel'
            }
        ];

        const currentQuestion = computed(() => questions[interviewStep.value]);

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

        const checkLogin = () => {
            const valid = credentials.find(c =>
                c.u.toLowerCase() === form.username.toLowerCase() &&
                c.p === form.password
            );

            if (valid) {
                errorMsg.value = '';
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

            if (interviewStep.value < questions.length - 1) {
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

        // --- API Helpers ---

        const getApiKey = () => {
            const key = localStorage.getItem('scriptoria_api_key');
            if (!key) throw new Error('No API Key found');
            return key;
        };

        // 1. Structured Output Call with Streaming (Gemini 2.5 Pro for Style Analysis)
        const callGeminiStructuredStream = async (userPrompt, schema) => {
            const apiKey = getApiKey();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${apiKey}`;

            const payload = {
                contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseJsonSchema: schema,
                    temperature: 0.6,
                    topP: 1.0,
                    maxOutputTokens: 60000,
                    thinkingConfig: {
                        includeThoughts: true,
                        thinkingBudget: 32000
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
        const callGeminiStream = async (userPrompt, systemPrompt, files = []) => {
            const apiKey = getApiKey();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse&key=${apiKey}`;

            const contents = [{ role: 'user', parts: [{ text: userPrompt }] }];

            // Handle Files (Inline)
            if (files.length > 0) {
                files.forEach(file => {
                    const base64Data = file.data.split(',')[1];
                    const mimeType = file.data.split(';')[0].split(':')[1];
                    contents[0].parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
                });
            }

            const payload = {
                contents: contents,
                system_instruction: { parts: [{ text: systemPrompt }] },
                generationConfig: {
                    temperature: 0.6,
                    topP: 1.0,
                    maxOutputTokens: 60000,
                    thinkingConfig: {
                        includeThoughts: true,
                        thinkingBudget: 24000
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

                    appState.value = 'DASHBOARD';
                    loadHistory();
                } else {
                    throw new Error('Failed to generate style profile');
                }
            } catch (e) {
                console.error(e);
                alert('Connection Severed. Please check your API Key and try again.');
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

                // Use Streaming
                await callGeminiStream(prompt, "You are a professional editor.", []);

                // Update history with new version
                addToHistory(homeworkForm.topic, true);
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
                appState.value = 'RESULT';
            }

            if (window.innerWidth < 768) isSidebarOpen.value = false; // Close sidebar on mobile
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
        const { watch, nextTick } = Vue;
        watch(thoughtLog, () => {
            nextTick(() => {
                if (thoughtLogContainer.value) {
                    thoughtLogContainer.value.scrollTop = thoughtLogContainer.value.scrollHeight;
                }
            });
        }, { deep: true });

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
            generatedContent,
            thoughtLog,
            thoughtLogContainer, // For auto-scroll
            copyBtnText,
            checkLogin,
            saveKey,
            // Style Interview
            interviewStep,
            styleForm,
            questions,
            currentQuestion,
            nextStep,
            prevStep,
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
            copyToClipboard
        };
    }
});

app.mount('#app');
