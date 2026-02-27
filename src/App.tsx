import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Camera, RefreshCw, Info, ArrowLeft, Sparkles, Loader2, AlertCircle, History, Trash2, Settings, Eye, EyeOff, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { PaintingInfo, getAllHistory, saveHistoryItem, clearAllHistory, deleteHistoryItem } from './db';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const API_KEY_STORAGE_KEY = 'museum_guide_openrouter_key';
const MODEL_STORAGE_KEY = 'museum_guide_openrouter_model';

// --- App Component ---
export default function App() {
  const [mode, setMode] = useState<'landing' | 'camera' | 'analyzing' | 'result' | 'history'>('landing');
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PaintingInfo | null>(null);
  const [history, setHistory] = useState<PaintingInfo[]>([]);
  const [isDeepLoading, setIsDeepLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [deepError, setDeepError] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE_KEY) || '');
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL);
  const [settingsApiKey, setSettingsApiKey] = useState('');
  const [settingsModel, setSettingsModel] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  
  // Load history from IndexedDB on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        // Migration from localStorage if it exists
        const saved = localStorage.getItem('museum_guide_history');
        if (saved) {
          const oldHistory = JSON.parse(saved) as PaintingInfo[];
          for (const item of oldHistory) {
            await saveHistoryItem(item);
          }
          localStorage.removeItem('museum_guide_history');
        }
        
        const data = await getAllHistory();
        setHistory(data);
      } catch (err) {
        console.error("Failed to load history:", err);
      }
    };
    loadHistory();
  }, []);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const openSettings = () => {
    setSettingsApiKey(apiKey);
    setSettingsModel(model);
    setShowApiKey(false);
    setShowSettings(true);
  };

  const saveSettings = () => {
    const trimmedKey = settingsApiKey.trim();
    const trimmedModel = settingsModel.trim() || DEFAULT_MODEL;
    localStorage.setItem(API_KEY_STORAGE_KEY, trimmedKey);
    localStorage.setItem(MODEL_STORAGE_KEY, trimmedModel);
    setApiKey(trimmedKey);
    setModel(trimmedModel);
    setShowSettings(false);
  };

  // --- Camera Logic ---
  const startCamera = async () => {
    if (!apiKey) {
      openSettings();
      return;
    }
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'environment'
        } 
      });
      streamRef.current = stream;
      setMode('camera');
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError("Could not access camera. Please ensure you have granted permissions and are using a secure connection (HTTPS).");
    }
  };

  // Callback ref to attach stream as soon as video element is mounted
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      // Use a promise-based play call and ignore AbortError which happens on unmount
      const playPromise = node.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          if (e.name !== 'AbortError') {
            console.error("Error playing video:", e);
          }
        });
      }
    }
    videoRef.current = node;
  }, []);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      // Scale down the image to a max dimension of 1024px to speed up upload
      const MAX_DIMENSION = 1024;
      let width = video.videoWidth;
      let height = video.videoHeight;
      
      if (width > height && width > MAX_DIMENSION) {
        height = Math.round((height * MAX_DIMENSION) / width);
        width = MAX_DIMENSION;
      } else if (height > MAX_DIMENSION) {
        width = Math.round((width * MAX_DIMENSION) / height);
        height = MAX_DIMENSION;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, width, height);
        // Compress with 0.8 quality
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        setCapturedImage(dataUrl);
        stopCamera();
        analyzeImage(dataUrl);
      }
    }
  };

  // --- OpenRouter API Logic ---
  const analyzeImage = async (base64Image: string) => {
    setMode('analyzing');
    setIsDeepLoading(true);
    setDeepError(false);
    setLoadingStatus('Uploading image...');

    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
      ]);
    };

    const extractJSON = (text: string): string => {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) return match[1].trim();
      return text.trim();
    };

    const callOpenRouter = async (prompt: string): Promise<string> => {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
          'X-Title': 'Museum Guide AI',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: base64Image }
                },
                {
                  type: 'text',
                  text: prompt
                }
              ]
            }
          ],
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 401 || response.status === 403) throw new Error('INVALID_API_KEY');
        if (response.status === 429) throw new Error('429');
        throw new Error(errorData?.error?.message || `API error: ${response.status}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '{}';
    };

    try {
      // PHASE 1: Basic Identification (Optimized for speed)
      setLoadingStatus('Identifying artwork...');
      const basicPrompt = `Identify this painting and provide basic details. You must respond with a JSON object containing exactly these fields:
- "name" (string): Name of the painting
- "artist" (string): Name of the artist
- "year" (string): Year or period it was painted
- "medium" (string): Materials used (e.g., Oil on canvas)
- "dimensions" (string): Physical dimensions if known
- "location" (string): Museum or collection where it is housed
- "description" (string): A brief, engaging overview of the painting

Return only the JSON object, no other text.`;

      const basicText = await withTimeout(callOpenRouter(basicPrompt), 30000);

      setLoadingStatus('Parsing details...');
      const basicResult = JSON.parse(extractJSON(basicText));
      
      const newEntry: PaintingInfo = {
        ...basicResult,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        image: base64Image
      };
      
      setAnalysis(newEntry);
      setHistory(prev => [newEntry, ...prev]);
      await saveHistoryItem(newEntry);
      setMode('result');

      // PHASE 2: Deep Analysis (Background, more detail)
      try {
        const deepPrompt = `Provide a deep analysis for the painting "${basicResult.name}" by ${basicResult.artist}. You must respond with a JSON object containing exactly these fields:
- "technique" (string): Detailed analysis of the artist's style, brushwork, and artistic methods
- "symbolism" (string): Hidden meanings and symbolic elements in the painting
- "detailsToLookFor" (array of strings): 5-7 specific details a viewer should observe in the painting
- "historicalContext" (string): The history, story, and significance behind the work

Return only the JSON object, no other text.`;
        
        const deepText = await withTimeout(callOpenRouter(deepPrompt), 45000);
        const deepResult = JSON.parse(extractJSON(deepText));
        const updatedEntry = { ...newEntry, ...deepResult };
        
        setAnalysis(updatedEntry);
        setHistory(prev => prev.map(item => item.id === newEntry.id ? updatedEntry : item));
        await saveHistoryItem(updatedEntry);
      } catch (deepErr) {
        console.error("Deep analysis error:", deepErr);
        setDeepError(true);
      } finally {
        setIsDeepLoading(false);
      }

    } catch (err: any) {
      console.error("Analysis error:", err);
      if (err.message === 'TIMEOUT') {
        setError("The museum archives are taking too long to respond. Please try again with a clearer photo or better connection.");
      } else if (err.message === 'INVALID_API_KEY') {
        setError("Invalid API key. Please check your OpenRouter API key in Settings.");
      } else {
        const isQuotaError = err?.message?.includes('429') || err?.message?.includes('quota');
        setError(isQuotaError ? "Museum archives are busy (Rate limit). Please wait a moment and try again." : "Failed to identify the painting. Please try again with a clearer photo.");
      }
      setMode('landing');
    }
  };

  const reset = () => {
    stopCamera();
    setCapturedImage(null);
    setAnalysis(null);
    setError(null);
    setMode('landing');
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#fdfcfb]">
      {/* Header */}
      <header className="p-6 flex justify-between items-center border-b border-stone-200 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-2" onClick={reset} style={{ cursor: 'pointer' }}>
          <div className="w-8 h-8 bg-stone-900 rounded-full flex items-center justify-center">
            <Sparkles className="text-white w-4 h-4" />
          </div>
          <h1 className="font-serif text-xl font-semibold tracking-tight">Museum Guide AI</h1>
        </div>
        <div className="flex items-center gap-4">
          <button 
            onClick={openSettings}
            className="text-stone-500 hover:text-stone-900 transition-colors"
            title="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
          {mode === 'landing' && history.length > 0 && (
            <button 
              onClick={() => setMode('history')}
              className="text-stone-500 hover:text-stone-900 transition-colors flex items-center gap-2 text-sm font-medium"
            >
              <History className="w-5 h-5" />
              History
            </button>
          )}
          {mode !== 'landing' && (
            <button 
              onClick={reset}
              className="text-stone-500 hover:text-stone-900 transition-colors"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 relative overflow-hidden flex flex-col">
        <AnimatePresence mode="wait">
          {mode === 'landing' && (
            <motion.div 
              key="landing"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex-1 flex flex-col items-center justify-center p-8 text-center"
            >
              <div className="max-w-md space-y-8">
                <div className="space-y-4">
                  <h2 className="text-5xl font-serif leading-tight">
                    Every painting has a <span className="italic">story</span>.
                  </h2>
                  <p className="text-stone-500 font-light text-lg">
                    Point your camera at any artwork to uncover its history, secrets, and hidden details.
                  </p>
                </div>

                {!apiKey && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700 text-left flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">API key required</p>
                      <p className="mt-1 text-amber-600">
                        You need an{' '}
                        <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="underline font-medium">OpenRouter API key</a>
                        {' '}to identify paintings. Tap the gear icon above to configure.
                      </p>
                    </div>
                  </div>
                )}
                
                <div className="flex flex-col gap-4 w-full max-w-xs mx-auto">
                  <button 
                    onClick={startCamera}
                    className="group relative inline-flex items-center justify-center gap-3 bg-stone-900 text-white px-8 py-4 rounded-full text-lg font-medium hover:bg-stone-800 transition-all active:scale-95 shadow-xl"
                  >
                    <Camera className="w-5 h-5" />
                    Start Exploring
                  </button>

                  {history.length > 0 && (
                    <button 
                      onClick={() => setMode('history')}
                      className="inline-flex items-center justify-center gap-3 bg-white text-stone-900 border border-stone-200 px-8 py-4 rounded-full text-lg font-medium hover:bg-stone-50 transition-all active:scale-95"
                    >
                      <History className="w-5 h-5" />
                      View History ({history.length})
                    </button>
                  )}
                </div>

                {error && (
                  <p className="text-red-500 text-sm bg-red-50 p-3 rounded-lg border border-red-100">
                    {error}
                  </p>
                )}
              </div>
            </motion.div>
          )}

          {mode === 'camera' && (
            <motion.div 
              key="camera"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex flex-col bg-black relative"
            >
              <video 
                ref={setVideoRef} 
                autoPlay 
                playsInline 
                muted
                className="flex-1 object-cover"
              />
              
              <div className="absolute bottom-12 left-0 right-0 flex justify-center items-center gap-8 px-6">
                <button 
                  onClick={reset}
                  className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white border border-white/20"
                >
                  <ArrowLeft className="w-6 h-6" />
                </button>
                
                <button 
                  onClick={capturePhoto}
                  className="w-20 h-20 rounded-full bg-white flex items-center justify-center shadow-2xl active:scale-90 transition-transform"
                >
                  <div className="w-16 h-16 rounded-full border-2 border-stone-900" />
                </button>

                <div className="w-12 h-12" /> {/* Spacer */}
              </div>

              <div className="absolute top-6 left-0 right-0 text-center">
                <span className="bg-black/40 backdrop-blur-md text-white px-4 py-2 rounded-full text-sm font-medium border border-white/10">
                  Align painting in frame
                </span>
              </div>
            </motion.div>
          )}

          {mode === 'analyzing' && (
            <motion.div 
              key="analyzing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex flex-col items-center justify-center p-8 bg-stone-50"
            >
              <div className="relative w-64 h-64 mb-8">
                {capturedImage && (
                  <img 
                    src={capturedImage} 
                    alt="Captured" 
                    className="w-full h-full object-cover rounded-2xl shadow-2xl opacity-50"
                  />
                )}
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <Loader2 className="w-12 h-12 text-stone-900 animate-spin" />
                  <p className="font-serif text-xl italic text-stone-900">Consulting the archives...</p>
                </div>
                <motion.div 
                  className="absolute inset-0 border-2 border-stone-900 rounded-2xl"
                  animate={{ 
                    scale: [1, 1.05, 1],
                    opacity: [0.5, 1, 0.5]
                  }}
                  transition={{ repeat: Infinity, duration: 2 }}
                />
              </div>
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center gap-6"
              >
                <div className="text-stone-500 text-sm font-medium tracking-wide uppercase">
                  {loadingStatus}
                </div>
                <button 
                  onClick={reset}
                  className="text-stone-400 hover:text-stone-600 text-xs font-bold uppercase tracking-widest border-b border-stone-200 pb-1 transition-colors"
                >
                  Cancel
                </button>
              </motion.div>
            </motion.div>
          )}

          {mode === 'history' && (
            <motion.div 
              key="history"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="flex-1 flex flex-col p-6 overflow-y-auto"
            >
              <div className="max-w-2xl mx-auto w-full space-y-8">
                <div className="flex justify-between items-end">
                  <div className="space-y-1">
                    <h2 className="text-3xl font-serif font-bold">Your Collection</h2>
                    <p className="text-stone-500 text-sm">Artwork you've discovered</p>
                  </div>
                  <button 
                    onClick={async () => {
                      if (confirm('Clear all history?')) {
                        await clearAllHistory();
                        setHistory([]);
                        setMode('landing');
                      }
                    }}
                    className="text-stone-400 hover:text-red-500 transition-colors p-2"
                    title="Clear All"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4">
                  {history.map((item) => (
                    <motion.div 
                      key={item.id}
                      layoutId={item.id}
                      onClick={() => {
                        setAnalysis(item);
                        setCapturedImage(item.image);
                        setIsDeepLoading(false);
                        setMode('result');
                      }}
                      className="group bg-white border border-stone-200 rounded-2xl overflow-hidden flex cursor-pointer hover:shadow-md transition-all active:scale-[0.98]"
                    >
                      <div className="w-24 h-24 sm:w-32 sm:h-32 flex-shrink-0">
                        <img 
                          src={item.image} 
                          alt={item.name} 
                          className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500"
                        />
                      </div>
                      <div className="p-4 flex-1 flex flex-col justify-center min-w-0 relative">
                        <button 
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (confirm(`Remove "${item.name}" from history?`)) {
                              await deleteHistoryItem(item.id);
                              setHistory(prev => prev.filter(h => h.id !== item.id));
                            }
                          }}
                          className="absolute top-2 right-2 p-2 text-stone-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <h3 className="font-serif font-bold text-lg truncate leading-tight pr-8">{item.name}</h3>
                        <p className="text-stone-500 text-sm truncate pr-8">{item.artist}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-widest text-stone-400 font-bold">
                            {new Date(item.timestamp).toLocaleDateString()}
                          </span>
                          {!item.technique && (
                            <span className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-amber-500 font-bold">
                              <Loader2 className="w-2 h-2 animate-spin" />
                              Processing
                            </span>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {mode === 'result' && analysis && (
            <motion.div 
              key="result"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex-1 overflow-y-auto"
            >
              <div className="max-w-2xl mx-auto p-6 space-y-8 pb-24">
                {/* Image Preview */}
                <div className="aspect-[4/3] w-full rounded-3xl overflow-hidden shadow-2xl bg-stone-200">
                  {capturedImage && (
                    <img 
                      src={capturedImage} 
                      alt={analysis.name} 
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>

                {/* Title & Artist */}
                <div className="space-y-2 border-b border-stone-200 pb-6">
                  <h2 className="text-4xl font-serif font-bold leading-tight">
                    {analysis.name}
                  </h2>
                  <div className="flex items-center gap-2 text-stone-500 text-lg">
                    <span className="font-medium text-stone-900">{analysis.artist}</span>
                    <span>•</span>
                    <span>{analysis.year}</span>
                  </div>
                </div>

                {/* Technical Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-stone-50 p-4 rounded-2xl border border-stone-100">
                    <span className="block text-[10px] uppercase tracking-widest text-stone-400 font-bold mb-1">Medium</span>
                    <span className="text-sm text-stone-700 font-medium">{analysis.medium}</span>
                  </div>
                  <div className="bg-stone-50 p-4 rounded-2xl border border-stone-100">
                    <span className="block text-[10px] uppercase tracking-widest text-stone-400 font-bold mb-1">Dimensions</span>
                    <span className="text-sm text-stone-700 font-medium">{analysis.dimensions}</span>
                  </div>
                  <div className="bg-stone-50 p-4 rounded-2xl border border-stone-100">
                    <span className="block text-[10px] uppercase tracking-widest text-stone-400 font-bold mb-1">Location</span>
                    <span className="text-sm text-stone-700 font-medium">{analysis.location}</span>
                  </div>
                </div>

                {/* Description */}
                <section className="space-y-4">
                  <div className="flex items-center gap-2 text-stone-400 uppercase tracking-widest text-xs font-bold">
                    <Info className="w-4 h-4" />
                    Overview
                  </div>
                  <p className="text-stone-700 leading-relaxed text-lg">
                    {analysis.description}
                  </p>
                </section>

                {/* Technique & Symbolism */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <section className="space-y-4">
                    <div className="flex items-center gap-2 text-stone-400 uppercase tracking-widest text-xs font-bold">
                      <Sparkles className="w-4 h-4" />
                      Technique
                    </div>
                    {analysis.technique ? (
                      <p className="text-stone-600 text-sm leading-relaxed">
                        {analysis.technique}
                      </p>
                    ) : (
                      <div className="space-y-2 animate-pulse">
                        <div className="h-3 bg-stone-100 rounded w-full" />
                        <div className="h-3 bg-stone-100 rounded w-5/6" />
                        <div className="h-3 bg-stone-100 rounded w-4/6" />
                      </div>
                    )}
                  </section>
                  <section className="space-y-4">
                    <div className="flex items-center gap-2 text-stone-400 uppercase tracking-widest text-xs font-bold">
                      <Info className="w-4 h-4" />
                      Symbolism
                    </div>
                    {analysis.symbolism ? (
                      <p className="text-stone-600 text-sm leading-relaxed">
                        {analysis.symbolism}
                      </p>
                    ) : (
                      <div className="space-y-2 animate-pulse">
                        <div className="h-3 bg-stone-100 rounded w-full" />
                        <div className="h-3 bg-stone-100 rounded w-5/6" />
                        <div className="h-3 bg-stone-100 rounded w-4/6" />
                      </div>
                    )}
                  </section>
                </div>

                {/* Details to Look For */}
                <section className="bg-stone-900 text-stone-100 p-8 rounded-3xl space-y-6 shadow-2xl relative overflow-hidden">
                  <div className="flex items-center gap-2 text-stone-400 uppercase tracking-widest text-xs font-bold">
                    <Sparkles className="w-4 h-4 text-stone-200" />
                    Details to Observe
                  </div>
                  {analysis.detailsToLookFor ? (
                    <ul className="space-y-4">
                      {analysis.detailsToLookFor.map((detail, idx) => (
                        <li key={idx} className="flex gap-4 items-start">
                          <span className="flex-shrink-0 w-6 h-6 bg-white text-stone-900 rounded-full flex items-center justify-center text-xs font-bold">
                            {idx + 1}
                          </span>
                          <p className="text-stone-200 font-medium leading-snug">{detail}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="space-y-4">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="flex gap-4 items-start animate-pulse">
                          <div className="w-6 h-6 bg-stone-800 rounded-full flex-shrink-0" />
                          <div className="h-4 bg-stone-800 rounded w-full mt-1" />
                        </div>
                      ))}
                    </div>
                  )}
                  {isDeepLoading && (
                    <div className="absolute top-8 right-8">
                      <Loader2 className="w-4 h-4 text-stone-500 animate-spin" />
                    </div>
                  )}
                  {deepError && (
                    <div className="absolute top-8 right-8 text-red-400">
                      <AlertCircle className="w-4 h-4" />
                    </div>
                  )}
                </section>

                {/* Historical Context */}
                <section className="space-y-4">
                  <div className="flex items-center gap-2 text-stone-400 uppercase tracking-widest text-xs font-bold">
                    <RefreshCw className="w-4 h-4" />
                    Historical Context
                  </div>
                  {analysis.historicalContext ? (
                    <div className="markdown-body text-stone-600 italic border-l-2 border-stone-200 pl-6 py-2">
                      <ReactMarkdown>{analysis.historicalContext}</ReactMarkdown>
                    </div>
                  ) : deepError ? (
                    <div className="p-4 bg-red-50 rounded-xl border border-red-100 flex items-center gap-3 text-red-600 text-sm italic">
                      <AlertCircle className="w-4 h-4" />
                      Deep analysis unavailable. The museum archives are currently over capacity.
                    </div>
                  ) : (
                    <div className="space-y-2 animate-pulse border-l-2 border-stone-100 pl-6 py-2">
                      <div className="h-3 bg-stone-50 rounded w-full" />
                      <div className="h-3 bg-stone-50 rounded w-11/12" />
                      <div className="h-3 bg-stone-50 rounded w-10/12" />
                    </div>
                  )}
                </section>

                {/* Action Buttons */}
                <div className="pt-8 flex gap-4">
                  <button 
                    onClick={startCamera}
                    className="flex-1 bg-stone-900 text-white py-4 rounded-2xl font-medium flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-all"
                  >
                    <Camera className="w-5 h-5" />
                    Scan Another
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer / Status */}
      <footer className="p-4 text-center text-[10px] text-stone-400 uppercase tracking-[0.2em] bg-white border-t border-stone-100">
        Museum Guide AI • Powered by OpenRouter
      </footer>

      {/* Hidden Canvas for Capturing */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm" 
              onClick={() => setShowSettings(false)} 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="relative bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 space-y-6"
            >
              <div className="flex justify-between items-center">
                <h2 className="text-2xl font-serif font-bold">Settings</h2>
                <button 
                  onClick={() => setShowSettings(false)} 
                  className="text-stone-400 hover:text-stone-900 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="space-y-5">
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-widest text-stone-400 font-bold block">
                    OpenRouter API Key
                  </label>
                  <div className="relative">
                    <input 
                      type={showApiKey ? 'text' : 'password'}
                      value={settingsApiKey}
                      onChange={(e) => setSettingsApiKey(e.target.value)}
                      placeholder="sk-or-..."
                      className="w-full border border-stone-200 rounded-xl px-4 py-3 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
                    />
                    <button 
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
                    >
                      {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <a 
                    href="https://openrouter.ai/keys" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-xs text-stone-400 hover:text-stone-600 underline inline-block"
                  >
                    Get an API key from OpenRouter
                  </a>
                </div>
                
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-widest text-stone-400 font-bold block">
                    Model
                  </label>
                  <input 
                    type="text"
                    value={settingsModel}
                    onChange={(e) => setSettingsModel(e.target.value)}
                    placeholder={DEFAULT_MODEL}
                    className="w-full border border-stone-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
                  />
                  <p className="text-xs text-stone-400">
                    Any vision-capable model on{' '}
                    <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="underline">OpenRouter</a>
                  </p>
                </div>
              </div>
              
              <button 
                onClick={saveSettings}
                disabled={!settingsApiKey.trim()}
                className="w-full bg-stone-900 text-white py-3 rounded-xl font-medium hover:bg-stone-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
              >
                Save Settings
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
