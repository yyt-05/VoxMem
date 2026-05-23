package main

import (
	"context"
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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthzHandler(cfg))
	mux.HandleFunc("GET /ws/asr", asrWebSocketHandler(cfg, logger))

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
	Type    string `json:"type"`
	TaskID  string `json:"task_id,omitempty"`
	Text    string `json:"text,omitempty"`
	Final   bool   `json:"final,omitempty"`
	Message string `json:"message,omitempty"`
}

func asrWebSocketHandler(cfg config, logger *slog.Logger) http.HandlerFunc {
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
		if cfg.asrMode == "mock" {
			handleMockASR(upgrader, cfg, logger, w, r)
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
		logger.Info("asr session ready", "task_id", started.TaskID, "mode", cfg.asrMode, "format", cfg.asrFormat, "sample_rate", cfg.asrSampleRate, "audio_debug", cfg.audioDebug)

		writeDone := make(chan struct{})
		go forwardASREvents(ctx, logger, stream, clientConn, writeDone)

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

func handleMockASR(upgrader websocket.Upgrader, cfg config, logger *slog.Logger, w http.ResponseWriter, r *http.Request) {
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
	logger.Info("mock asr session ready", "task_id", taskID, "audio_debug", cfg.audioDebug)

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
			_ = clientConn.WriteJSON(clientEvent{Type: "done", TaskID: taskID})
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

func forwardASREvents(ctx context.Context, logger *slog.Logger, stream *asr.Stream, clientConn *websocket.Conn, done chan<- struct{}) {
	defer close(done)

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

			if text, final := asr.ExtractSentence(event); text != "" {
				logger.Info("forward asr transcript", "task_id", stream.TaskID(), "final", final, "text_len", len(text))
				if err := clientConn.WriteJSON(clientEvent{Type: "transcript", Text: text, Final: final}); err != nil {
					logger.Warn("forward transcript failed", "error", err)
					return
				}
			}
			if event.Header.Event == "task-finished" {
				_ = clientConn.WriteJSON(clientEvent{Type: "done", TaskID: stream.TaskID()})
				return
			}
		}
	}
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
