package asr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	DefaultEndpoint   = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
	DefaultModel      = "paraformer-realtime-v2"
	DefaultFormat     = "pcm"
	DefaultSampleRate = 16000
	DefaultChunkSize  = 3200
)

type Config struct {
	APIKey     string
	Endpoint   string
	Model      string
	Format     string
	SampleRate int
	ChunkSize  int
	UserAgent  string
}

type ProbeResult struct {
	TaskID        string
	Started       bool
	Finished      bool
	FinalText     string
	Events        []ServerEvent
	AudioBytes    int64
	AudioDuration time.Duration
}

type ServerEvent struct {
	Header  EventHeader     `json:"header"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Raw     string          `json:"-"`
}

type EventHeader struct {
	Event        string `json:"event"`
	TaskID       string `json:"task_id"`
	ErrorCode    string `json:"error_code"`
	ErrorMessage string `json:"error_message"`
	Code         string `json:"code"`
	Message      string `json:"message"`
}

type recognitionEvent struct {
	Payload struct {
		Output struct {
			Sentence struct {
				Text        string `json:"text"`
				SentenceEnd bool   `json:"sentence_end"`
			} `json:"sentence"`
		} `json:"output"`
	} `json:"payload"`
}

func (c Config) withDefaults() (Config, error) {
	if c.APIKey == "" {
		return c, errors.New("DASHSCOPE_API_KEY is required")
	}
	if c.Endpoint == "" {
		c.Endpoint = DefaultEndpoint
	}
	if c.Model == "" {
		c.Model = DefaultModel
	}
	if c.Format == "" {
		c.Format = DefaultFormat
	}
	if c.SampleRate == 0 {
		c.SampleRate = DefaultSampleRate
	}
	if c.ChunkSize == 0 {
		c.ChunkSize = DefaultChunkSize
	}
	if c.UserAgent == "" {
		c.UserAgent = "VoxMem ASR Probe"
	}
	return c, nil
}

func CheckTask(ctx context.Context, cfg Config) (*ProbeResult, error) {
	cfg, err := cfg.withDefaults()
	if err != nil {
		return nil, err
	}

	conn, events, errCh, closeFn, err := connect(ctx, cfg)
	if err != nil {
		return nil, err
	}
	defer closeFn()

	taskID := uuid.NewString()
	result := &ProbeResult{TaskID: taskID}

	if err := writeJSONMessage(conn, runTaskMessage(taskID, cfg)); err != nil {
		return nil, fmt.Errorf("send run-task: %w", err)
	}
	if err := waitForStarted(ctx, events, errCh, result); err != nil {
		return result, err
	}
	return result, nil
}

func RecognizeFile(ctx context.Context, cfg Config, audioPath string) (*ProbeResult, error) {
	cfg, err := cfg.withDefaults()
	if err != nil {
		return nil, err
	}
	if audioPath == "" {
		return nil, errors.New("audio path is required")
	}

	audio, err := os.Open(audioPath)
	if err != nil {
		return nil, fmt.Errorf("open audio file: %w", err)
	}
	defer audio.Close()

	conn, events, errCh, closeFn, err := connect(ctx, cfg)
	if err != nil {
		return nil, err
	}
	defer closeFn()

	taskID := uuid.NewString()
	result := &ProbeResult{TaskID: taskID}

	if err := writeJSONMessage(conn, runTaskMessage(taskID, cfg)); err != nil {
		return nil, fmt.Errorf("send run-task: %w", err)
	}
	if err := waitForStarted(ctx, events, errCh, result); err != nil {
		return result, err
	}

	audioStartedAt := time.Now()
	audioBytes, err := sendAudio(ctx, conn, audio, cfg.ChunkSize)
	result.AudioBytes = audioBytes
	result.AudioDuration = time.Since(audioStartedAt)
	if err != nil {
		return result, err
	}

	if err := writeJSONMessage(conn, finishTaskMessage(taskID)); err != nil {
		return result, fmt.Errorf("send finish-task: %w", err)
	}
	if err := waitForFinished(ctx, events, errCh, result); err != nil {
		return result, err
	}
	return result, nil
}

func connect(ctx context.Context, cfg Config) (*websocket.Conn, <-chan ServerEvent, <-chan error, func(), error) {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+cfg.APIKey)
	headers.Set("User-Agent", cfg.UserAgent)

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, cfg.Endpoint, headers)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("connect dashscope websocket: %w", err)
	}

	events := make(chan ServerEvent, 16)
	errCh := make(chan error, 1)

	go readEvents(conn, events, errCh)

	closeFn := func() {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
		_ = conn.Close()
	}

	return conn, events, errCh, closeFn, nil
}

func readEvents(conn *websocket.Conn, events chan<- ServerEvent, errCh chan<- error) {
	defer close(events)

	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return
			}
			errCh <- err
			return
		}
		if messageType != websocket.TextMessage {
			continue
		}

		var event ServerEvent
		if err := json.Unmarshal(data, &event); err != nil {
			errCh <- fmt.Errorf("parse server event: %w", err)
			return
		}
		event.Raw = string(data)
		events <- event
	}
}

func waitForStarted(ctx context.Context, events <-chan ServerEvent, errCh <-chan error, result *ProbeResult) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errCh:
			if err != nil {
				return err
			}
		case event, ok := <-events:
			if !ok {
				return errors.New("websocket closed before task-started")
			}
			appendEvent(result, event)
			if isFailure(event) {
				return failureError(event)
			}
			if event.Header.Event == "task-started" {
				result.Started = true
				return nil
			}
		}
	}
}

func waitForFinished(ctx context.Context, events <-chan ServerEvent, errCh <-chan error, result *ProbeResult) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errCh:
			if err != nil {
				return err
			}
		case event, ok := <-events:
			if !ok {
				if result.Finished {
					return nil
				}
				return errors.New("websocket closed before task-finished")
			}
			appendEvent(result, event)
			if isFailure(event) {
				return failureError(event)
			}
			if event.Header.Event == "task-finished" {
				result.Finished = true
				return nil
			}
		}
	}
}

func appendEvent(result *ProbeResult, event ServerEvent) {
	result.Events = append(result.Events, event)

	if event.Header.Event != "result-generated" {
		return
	}

	var recognition recognitionEvent
	if err := json.Unmarshal([]byte(event.Raw), &recognition); err != nil {
		return
	}

	text := strings.TrimSpace(recognition.Payload.Output.Sentence.Text)
	if text != "" && recognition.Payload.Output.Sentence.SentenceEnd {
		if result.FinalText != "" {
			result.FinalText += "\n"
		}
		result.FinalText += text
	}
}

func isFailure(event ServerEvent) bool {
	return strings.Contains(event.Header.Event, "failed") || event.Header.ErrorCode != "" || event.Header.Code != ""
}

func failureError(event ServerEvent) error {
	message := event.Header.ErrorMessage
	if message == "" {
		message = event.Header.Message
	}
	if message == "" {
		message = event.Raw
	}
	code := event.Header.ErrorCode
	if code == "" {
		code = event.Header.Code
	}
	if code == "" {
		return fmt.Errorf("dashscope task failed: %s", message)
	}
	return fmt.Errorf("dashscope task failed: %s: %s", code, message)
}

func writeJSONMessage(conn *websocket.Conn, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}

func sendAudio(ctx context.Context, conn *websocket.Conn, audio io.Reader, chunkSize int) (int64, error) {
	buffer := make([]byte, chunkSize)
	var total int64

	for {
		n, err := audio.Read(buffer)
		if n > 0 {
			select {
			case <-ctx.Done():
				return total, ctx.Err()
			default:
			}
			if writeErr := conn.WriteMessage(websocket.BinaryMessage, buffer[:n]); writeErr != nil {
				return total, fmt.Errorf("send audio chunk: %w", writeErr)
			}
			total += int64(n)
			time.Sleep(100 * time.Millisecond)
		}
		if errors.Is(err, io.EOF) {
			return total, nil
		}
		if err != nil {
			return total, fmt.Errorf("read audio file: %w", err)
		}
	}
}

func runTaskMessage(taskID string, cfg Config) map[string]any {
	return map[string]any{
		"header": map[string]any{
			"action":    "run-task",
			"task_id":   taskID,
			"streaming": "duplex",
		},
		"payload": map[string]any{
			"task_group": "audio",
			"task":       "asr",
			"function":   "recognition",
			"model":      cfg.Model,
			"parameters": map[string]any{
				"format":                     cfg.Format,
				"sample_rate":                cfg.SampleRate,
				"disfluency_removal_enabled": false,
			},
			"input": map[string]any{},
		},
	}
}

func finishTaskMessage(taskID string) map[string]any {
	return map[string]any{
		"header": map[string]any{
			"action":    "finish-task",
			"task_id":   taskID,
			"streaming": "duplex",
		},
		"payload": map[string]any{
			"input": map[string]any{},
		},
	}
}
