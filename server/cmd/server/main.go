package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/yyt-05/VoxMem/server/internal/asr"
	"github.com/yyt-05/VoxMem/server/internal/audiodebug"
	"github.com/yyt-05/VoxMem/server/internal/localenv"
	"github.com/yyt-05/VoxMem/server/internal/memory"
	"github.com/yyt-05/VoxMem/server/internal/textproc"
)

const serviceName = "voxmem-api"

type config struct {
	addr           string
	allowedOrigins map[string]struct{}
	env            string
	asrMode        string
	asrMockText    string
	asrAPIKey      string
	asrEndpoint    string
	asrModel       string
	asrFormat      string
	asrSampleRate  int
	audioDebug     bool
	audioDebugDir  string
	dbPath         string
	llmAPIKey      string
	llmBaseURL     string
	llmModel       string
	llmTimeout     time.Duration
}

type healthResponse struct {
	Status    string `json:"status"`
	Service   string `json:"service"`
	Env       string `json:"env"`
	Timestamp string `json:"timestamp"`
}

func main() {
	if err := localenv.LoadFiles(".env", ".env.local", "../.env", "../.env.local"); err != nil {
		slog.Warn("failed to load local env file", "error", err)
	}

	cfg := loadConfig()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	store, err := memory.Open(cfg.dbPath)
	if err != nil {
		logger.Error("open memory store failed", "error", err, "db_path", cfg.dbPath)
		os.Exit(1)
	}
	defer store.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthzHandler(cfg))
	mux.HandleFunc("GET /ws/asr", asrWebSocketHandler(cfg, logger, store))
	mux.HandleFunc("POST /api/input/commit", inputCommitHandler(cfg, store, logger))
	mux.HandleFunc("POST /api/correction", correctionHandler(store, logger))
	mux.HandleFunc("GET /api/hotwords", hotwordsHandler(store, logger))
	mux.HandleFunc("DELETE /api/hotwords/{id}", deleteHotwordHandler(store, logger))

	server := &http.Server{
		Addr:              cfg.addr,
		Handler:           withCORS(cfg, requestLogger(logger, mux)),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("starting server", "addr", cfg.addr, "env", cfg.env, "asr_mode", cfg.asrMode, "audio_debug", cfg.audioDebug, "audio_debug_dir", cfg.audioDebugDir)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("server stopped")
}

func loadConfig() config {
	addr := strings.TrimSpace(os.Getenv("VOXMEM_SERVER_ADDR"))
	if addr == "" {
		addr = ":8080"
	}

	env := strings.TrimSpace(os.Getenv("VOXMEM_ENV"))
	if env == "" {
		env = "development"
	}

	origins := strings.TrimSpace(os.Getenv("VOXMEM_ALLOWED_ORIGINS"))
	if origins == "" {
		origins = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"
	}

	allowedOrigins := make(map[string]struct{})
	for _, origin := range strings.Split(origins, ",") {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			allowedOrigins[origin] = struct{}{}
		}
	}

	return config{
		addr:           addr,
		allowedOrigins: allowedOrigins,
		env:            env,
		asrMode:        getenv("VOXMEM_ASR_MODE", "aliyun"),
		asrMockText:    getenv("VOXMEM_ASR_MOCK_TEXT", "mock final text"),
		asrAPIKey:      strings.TrimSpace(os.Getenv("DASHSCOPE_API_KEY")),
		asrEndpoint:    getenv("VOXMEM_ASR_ENDPOINT", asr.DefaultEndpoint),
		asrModel:       getenv("VOXMEM_ASR_MODEL", asr.DefaultModel),
		asrFormat:      getenv("VOXMEM_ASR_FORMAT", asr.DefaultFormat),
		asrSampleRate:  getenvInt("VOXMEM_ASR_SAMPLE_RATE", asr.DefaultSampleRate),
		audioDebug:     getenvBool("VOXMEM_AUDIO_DEBUG_ENABLED", false),
		audioDebugDir:  getenv("VOXMEM_AUDIO_DEBUG_DIR", filepath.Join("..", "tmp", "audio-debug")),
		dbPath:         getenv("VOXMEM_DB_PATH", filepath.Join("..", "data", "voxmem.db")),
		llmAPIKey:      strings.TrimSpace(os.Getenv("VOXMEM_LLM_API_KEY")),
		llmBaseURL:     strings.TrimSpace(os.Getenv("VOXMEM_LLM_BASE_URL")),
		llmModel:       strings.TrimSpace(os.Getenv("VOXMEM_LLM_MODEL")),
		llmTimeout:     time.Duration(getenvInt("VOXMEM_LLM_TIMEOUT_SECONDS", 8)) * time.Second,
	}
}

func healthzHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, healthResponse{
			Status:    "ok",
			Service:   serviceName,
			Env:       cfg.env,
			Timestamp: time.Now().UTC().Format(time.RFC3339),
		})
	}
}

type clientEvent struct {
	Type         string           `json:"type"`
	TaskID       string           `json:"task_id,omitempty"`
	Text         string           `json:"text,omitempty"`
	Final        bool             `json:"final,omitempty"`
	Message      string           `json:"message,omitempty"`
	Mode         textproc.Mode    `json:"mode,omitempty"`
	Status       string           `json:"status,omitempty"`
	Source       string           `json:"source,omitempty"`
	LatencyMS    int64            `json:"latency_ms,omitempty"`
	OriginalText string           `json:"original_text,omitempty"`
	EnhancedText string           `json:"enhanced_text,omitempty"`
	Mappings     []memory.Mapping `json:"mappings,omitempty"`
}

func asrWebSocketHandler(cfg config, logger *slog.Logger, store *memory.Store) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  8192,
		WriteBufferSize: 8192,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			_, ok := cfg.allowedOrigins[origin]
			return ok || origin == ""
		},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
		if userID == "" {
			http.Error(w, "user_id is required", http.StatusBadRequest)
			return
		}
		mode, err := textproc.ParseMode(r.URL.Query().Get("mode"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := store.EnsureUser(r.Context(), userID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		if cfg.asrMode == "mock" {
			handleMockASR(upgrader, cfg, logger, store, userID, mode, w, r)
			return
		}

		if cfg.asrAPIKey == "" {
			http.Error(w, "DASHSCOPE_API_KEY is not configured", http.StatusServiceUnavailable)
			return
		}

		clientConn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Warn("upgrade websocket failed", "error", err)
			return
		}
		defer clientConn.Close()

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		stream, started, err := asr.OpenStream(ctx, asr.Config{
			APIKey:     cfg.asrAPIKey,
			Endpoint:   cfg.asrEndpoint,
			Model:      cfg.asrModel,
			Format:     cfg.asrFormat,
			SampleRate: cfg.asrSampleRate,
		})
		if err != nil {
			_ = clientConn.WriteJSON(clientEvent{Type: "error", Message: err.Error()})
			logger.Warn("open asr stream failed", "error", err)
			return
		}
		defer stream.Close()

		if err := clientConn.WriteJSON(clientEvent{Type: "ready", TaskID: started.TaskID}); err != nil {
			logger.Warn("send ready failed", "error", err)
			return
		}
		debugRecorder, err := newAudioDebugRecorder(cfg, started.TaskID, logger)
		if err != nil {
			_ = clientConn.WriteJSON(clientEvent{Type: "error", Message: err.Error()})
			logger.Warn("create audio debug recorder failed", "task_id", started.TaskID, "error", err)
			return
		}
		if debugRecorder != nil {
			defer closeAudioDebugRecorder(debugRecorder, logger, started.TaskID)
		}

		sessionStartedAt := time.Now()
		logger.Info("asr session ready", "task_id", started.TaskID, "user_id", userID, "mode", cfg.asrMode, "output_mode", mode, "format", cfg.asrFormat, "sample_rate", cfg.asrSampleRate, "audio_debug", cfg.audioDebug)

		writeDone := make(chan struct{})
		go forwardASREvents(ctx, cfg, logger, store, userID, mode, stream, clientConn, writeDone)

		audioFrames := 0
		audioBytes := 0
		for {
			messageType, data, err := clientConn.ReadMessage()
			if err != nil {
				if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					logger.Warn("read browser websocket failed", "task_id", started.TaskID, "audio_frames", audioFrames, "audio_bytes", audioBytes, "error", err)
				}
				return
			}

			switch messageType {
			case websocket.BinaryMessage:
				audioFrames++
				audioBytes += len(data)
				if debugRecorder != nil {
					if err := debugRecorder.Write(data); err != nil {
						logger.Warn("write audio debug failed", "task_id", started.TaskID, "error", err)
					}
				}
				if audioFrames == 1 || audioFrames%50 == 0 {
					logger.Info("received browser audio", "task_id", started.TaskID, "audio_frames", audioFrames, "audio_bytes", audioBytes)
				}
				if err := stream.SendAudio(data); err != nil {
					_ = clientConn.WriteJSON(clientEvent{Type: "error", Message: err.Error()})
					logger.Warn("send audio to asr failed", "error", err)
					return
				}
			case websocket.TextMessage:
				var message clientEvent
				if err := json.Unmarshal(data, &message); err != nil {
					continue
				}
				if message.Type == "stop" {
					logger.Info("browser requested asr stop", "task_id", started.TaskID, "audio_frames", audioFrames, "audio_bytes", audioBytes, "duration_ms", time.Since(sessionStartedAt).Milliseconds())
					if err := stream.Finish(); err != nil {
						_ = clientConn.WriteJSON(clientEvent{Type: "error", Message: err.Error()})
						logger.Warn("finish asr stream failed", "error", err)
						return
					}
					select {
					case <-writeDone:
					case <-time.After(10 * time.Second):
						_ = clientConn.WriteJSON(clientEvent{Type: "error", Message: "timeout waiting for ASR completion"})
					}
					return
				}
			}
		}
	}
}

func handleMockASR(upgrader websocket.Upgrader, cfg config, logger *slog.Logger, store *memory.Store, userID string, mode textproc.Mode, w http.ResponseWriter, r *http.Request) {
	clientConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Warn("upgrade mock websocket failed", "error", err)
		return
	}
	defer clientConn.Close()

	taskID := "mock-task-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if err := clientConn.WriteJSON(clientEvent{Type: "ready", TaskID: taskID}); err != nil {
		logger.Warn("send mock ready failed", "error", err)
		return
	}
	debugRecorder, err := newAudioDebugRecorder(cfg, taskID, logger)
	if err != nil {
		_ = clientConn.WriteJSON(clientEvent{Type: "error", Message: err.Error()})
		logger.Warn("create mock audio debug recorder failed", "task_id", taskID, "error", err)
		return
	}
	if debugRecorder != nil {
		defer closeAudioDebugRecorder(debugRecorder, logger, taskID)
	}
	logger.Info("mock asr session ready", "task_id", taskID, "user_id", userID, "output_mode", mode, "audio_debug", cfg.audioDebug)

	audioFrames := 0
	audioBytes := 0
	for {
		messageType, data, err := clientConn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				logger.Warn("read mock websocket failed", "task_id", taskID, "audio_frames", audioFrames, "audio_bytes", audioBytes, "error", err)
			}
			return
		}

		if messageType == websocket.BinaryMessage {
			audioFrames++
			audioBytes += len(data)
			if debugRecorder != nil {
				if err := debugRecorder.Write(data); err != nil {
					logger.Warn("write mock audio debug failed", "task_id", taskID, "error", err)
				}
			}
			if audioFrames == 1 {
				_ = clientConn.WriteJSON(clientEvent{Type: "transcript", Text: strings.TrimSuffix(cfg.asrMockText, "."), Final: false})
			}
			continue
		}

		if messageType != websocket.TextMessage {
			continue
		}

		var message clientEvent
		if err := json.Unmarshal(data, &message); err != nil {
			continue
		}
		if message.Type == "stop" {
			logger.Info("browser requested mock asr stop", "task_id", taskID, "audio_frames", audioFrames, "audio_bytes", audioBytes)
			if audioFrames == 0 {
				_ = clientConn.WriteJSON(clientEvent{Type: "transcript", Text: strings.TrimSuffix(cfg.asrMockText, "."), Final: false})
			}
			_ = clientConn.WriteJSON(clientEvent{Type: "transcript", Text: cfg.asrMockText, Final: true})
			finalizeOutput(r.Context(), cfg, logger, store, userID, mode, taskID, cfg.asrMockText, clientConn)
			return
		}
	}
}

func newAudioDebugRecorder(cfg config, taskID string, logger *slog.Logger) (*audiodebug.Recorder, error) {
	if !cfg.audioDebug {
		return nil, nil
	}
	recorder, err := audiodebug.NewRecorder(cfg.audioDebugDir, taskID, cfg.asrSampleRate)
	if err != nil {
		return nil, err
	}
	logger.Info("audio debug recording started", "task_id", taskID, "dir", cfg.audioDebugDir)
	return recorder, nil
}

func closeAudioDebugRecorder(recorder *audiodebug.Recorder, logger *slog.Logger, taskID string) {
	pcmPath, wavPath, bytes, err := recorder.Close()
	if err != nil {
		logger.Warn("audio debug recording close failed", "task_id", taskID, "error", err)
		return
	}
	logger.Info("audio debug recording saved", "task_id", taskID, "pcm_path", pcmPath, "wav_path", wavPath, "audio_bytes", bytes)
}

func forwardASREvents(ctx context.Context, cfg config, logger *slog.Logger, store *memory.Store, userID string, mode textproc.Mode, stream *asr.Stream, clientConn *websocket.Conn, done chan<- struct{}) {
	defer close(done)

	finalSegments := []string{}
	for {
		select {
		case <-ctx.Done():
			return
		case err := <-stream.Errors():
			if err != nil {
				_ = clientConn.WriteJSON(clientEvent{Type: "error", Message: err.Error()})
				return
			}
		case event, ok := <-stream.Events():
			if !ok {
				return
			}

			logger.Info("asr event received", "task_id", stream.TaskID(), "event", event.Header.Event, "raw_len", len(event.Raw), "raw_preview", truncateLogValue(event.Raw, 500))
			if text, final := asr.ExtractSentence(event); text != "" {
				logger.Info("forward asr transcript", "task_id", stream.TaskID(), "final", final, "text_len", len(text))
				if final {
					finalSegments = append(finalSegments, text)
				}
				if err := clientConn.WriteJSON(clientEvent{Type: "transcript", Text: text, Final: final}); err != nil {
					logger.Warn("forward transcript failed", "error", err)
					return
				}
			}
			if event.Header.Event == "task-finished" {
				finalizeOutput(ctx, cfg, logger, store, userID, mode, stream.TaskID(), strings.Join(finalSegments, ""), clientConn)
				return
			}
		}
	}
}

func finalizeOutput(ctx context.Context, cfg config, logger *slog.Logger, store *memory.Store, userID string, mode textproc.Mode, taskID string, originalText string, clientConn *websocket.Conn) {
	originalText = strings.TrimSpace(originalText)
	if originalText == "" {
		_ = clientConn.WriteJSON(clientEvent{Type: "done", TaskID: taskID})
		return
	}

	enhancedText, hits, err := store.ApplyMappings(ctx, userID, originalText)
	if err != nil {
		_ = clientConn.WriteJSON(clientEvent{Type: "error", TaskID: taskID, Message: err.Error(), OriginalText: originalText, Mode: mode})
		logger.Warn("apply local mappings failed", "task_id", taskID, "user_id", userID, "error", err)
		return
	}

	if err := clientConn.WriteJSON(clientEvent{
		Type:         "input_ready",
		TaskID:       taskID,
		Text:         enhancedText,
		Final:        true,
		Mode:         mode,
		Status:       "ready",
		Source:       "local",
		OriginalText: originalText,
		EnhancedText: enhancedText,
		Mappings:     hits,
	}); err != nil {
		logger.Warn("forward input text failed", "task_id", taskID, "error", err)
		return
	}
	_ = clientConn.WriteJSON(clientEvent{Type: "done", TaskID: taskID})
}

type inputCommitRequest struct {
	UserID       string        `json:"user_id"`
	SessionID    string        `json:"session_id"`
	Mode         textproc.Mode `json:"mode"`
	OriginalText string        `json:"original_text"`
	EnhancedText string        `json:"enhanced_text"`
	FinalText    string        `json:"final_text"`
	RequestID    string        `json:"request_id,omitempty"`
}

type inputCommitResponse struct {
	Status    string           `json:"status"`
	Text      string           `json:"text"`
	Mode      textproc.Mode    `json:"mode"`
	Source    string           `json:"source"`
	LatencyMS int64            `json:"latency_ms"`
	Mappings  []memory.Mapping `json:"mappings"`
}

func inputCommitHandler(cfg config, store *memory.Store, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request inputCommitRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			logger.Warn("decode input commit body failed", "error", err)
			writeError(w, http.StatusBadRequest, err)
			return
		}

		userID := strings.TrimSpace(request.UserID)
		if userID == "" {
			writeError(w, http.StatusBadRequest, errors.New("user_id is required"))
			return
		}

		mode, err := textproc.ParseMode(string(request.Mode))
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		finalText := strings.TrimSpace(request.FinalText)
		if finalText == "" {
			writeError(w, http.StatusBadRequest, errors.New("final_text is required"))
			return
		}

		originalText := strings.TrimSpace(request.OriginalText)
		enhancedText := strings.TrimSpace(request.EnhancedText)
		baselineText := enhancedText
		if baselineText == "" {
			baselineText = originalText
		}

		mappings := []memory.Mapping{}
		if baselineText != "" && finalText != baselineText {
			mappings, err = store.SaveCorrection(r.Context(), memory.Correction{
				UserID:        userID,
				SessionID:     request.SessionID,
				OriginalText:  originalText,
				EnhancedText:  enhancedText,
				CorrectedText: finalText,
			})
			if err != nil {
				logger.Warn("save input correction failed", "user_id", userID, "request_id", request.RequestID, "error", err)
				writeError(w, http.StatusBadRequest, err)
				return
			}
		} else if err := store.EnsureUser(r.Context(), userID); err != nil {
			logger.Warn("ensure input user failed", "user_id", userID, "error", err)
			writeError(w, http.StatusBadRequest, err)
			return
		}

		result, err := textproc.Process(r.Context(), textproc.Config{
			APIKey:  cfg.llmAPIKey,
			BaseURL: cfg.llmBaseURL,
			Model:   cfg.llmModel,
			Timeout: cfg.llmTimeout,
		}, mode, finalText)
		if err != nil {
			logger.Warn("input text processing failed", "user_id", userID, "mode", mode, "request_id", request.RequestID, "error", err)
			writeError(w, http.StatusBadRequest, err)
			return
		}

		writeJSON(w, http.StatusOK, inputCommitResponse{
			Status:    result.Status,
			Text:      result.Text,
			Mode:      result.Mode,
			Source:    result.Source,
			LatencyMS: result.LatencyMS,
			Mappings:  mappings,
		})
	}
}

type correctionRequest struct {
	UserID        string `json:"user_id"`
	SessionID     string `json:"session_id"`
	OriginalText  string `json:"original_text"`
	EnhancedText  string `json:"enhanced_text"`
	CorrectedText string `json:"corrected_text"`
}

type correctionResponse struct {
	Status   string           `json:"status"`
	Mappings []memory.Mapping `json:"mappings"`
}

func correctionHandler(store *memory.Store, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request correctionRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		mappings, err := store.SaveCorrection(r.Context(), memory.Correction{
			UserID:        request.UserID,
			SessionID:     request.SessionID,
			OriginalText:  request.OriginalText,
			EnhancedText:  request.EnhancedText,
			CorrectedText: request.CorrectedText,
		})
		if err != nil {
			logger.Warn("save correction failed", "user_id", request.UserID, "error", err)
			writeError(w, http.StatusBadRequest, err)
			return
		}

		writeJSON(w, http.StatusOK, correctionResponse{Status: "ok", Mappings: mappings})
	}
}

func hotwordsHandler(store *memory.Store, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
		mappings, err := store.ListMappings(r.Context(), userID)
		if err != nil {
			logger.Warn("list hotwords failed", "user_id", userID, "error", err)
			writeError(w, http.StatusBadRequest, err)
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"mappings": mappings,
		})
	}
}

func deleteHotwordHandler(store *memory.Store, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		if err := store.DeleteMapping(r.Context(), userID, id); err != nil {
			logger.Warn("delete hotword failed", "user_id", userID, "id", id, "error", err)
			if errors.Is(err, sql.ErrNoRows) {
				writeError(w, http.StatusNotFound, err)
				return
			}
			writeError(w, http.StatusBadRequest, err)
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func truncateLogValue(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

func requestLogger(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startedAt := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(startedAt).Milliseconds())
	})
}

func withCORS(cfg config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if _, ok := cfg.allowedOrigins[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(statusCode)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Error("failed to write json response", "error", err)
	}
}

func writeError(w http.ResponseWriter, statusCode int, err error) {
	message := "unknown error"
	if err != nil {
		message = err.Error()
	}
	writeJSON(w, statusCode, map[string]string{
		"error": message,
	})
}

func getenv(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func getenvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvBool(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}
