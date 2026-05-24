package asr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const FileTranscribeEndpoint = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"
const TaskQueryEndpoint = "https://dashscope.aliyuncs.com/api/v1/tasks"

type FileTranscribeConfig struct {
	APIKey             string
	FileURL            string
	DiarizationEnabled bool
	SpeakerCount       int
}

type TranscriptionResult struct {
	Sentences []SentenceResult `json:"sentences"`
}

type SentenceResult struct {
	Text      string `json:"text"`
	SpeakerID int    `json:"speaker_id"`
	BeginTime int    `json:"begin_time"`
	EndTime   int    `json:"end_time"`
}

type fileTranscribeRequest struct {
	Model      string              `json:"model"`
	Input      fileTranscribeInput `json:"input"`
	Parameters transcribeParams    `json:"parameters"`
}

type fileTranscribeInput struct {
	FileURLs []string `json:"file_urls"`
}

type transcribeParams struct {
	ChannelID          []int `json:"channel_id"`
	DiarizationEnabled bool  `json:"diarization_enabled,omitempty"`
	SpeakerCount       int   `json:"speaker_count,omitempty"`
}

type fileTranscribeResponse struct {
	Output struct {
		TaskStatus string `json:"task_status"`
		TaskID     string `json:"task_id"`
	} `json:"output"`
	RequestID string `json:"request_id"`
}

type taskQueryResponse struct {
	Output struct {
		TaskStatus string                `json:"task_status"`
		TaskID     string                `json:"task_id"`
		Results    []taskQueryResultItem `json:"results"`
	} `json:"output"`
}

type taskQueryResultItem struct {
	SubtaskStatus    string `json:"subtask_status"`
	TranscriptionURL string `json:"transcription_url"`
}

type transcriptionFile struct {
	Transcripts []transcriptionTranscript `json:"transcripts"`
}

type transcriptionTranscript struct {
	Sentences []transcriptionSentence `json:"sentences"`
}

type transcriptionSentence struct {
	Text      string `json:"text"`
	SpeakerID int    `json:"speaker_id"`
	BeginTime int    `json:"begin_time"`
	EndTime   int    `json:"end_time"`
}

func SubmitFileTranscription(ctx context.Context, cfg FileTranscribeConfig) (string, error) {
	if strings.TrimSpace(cfg.APIKey) == "" {
		return "", fmt.Errorf("DASHSCOPE_API_KEY is required")
	}
	if strings.TrimSpace(cfg.FileURL) == "" {
		return "", fmt.Errorf("file_url is required")
	}
	if cfg.DiarizationEnabled {
		if cfg.SpeakerCount < 2 {
			cfg.SpeakerCount = 2
		}
	}

	body := fileTranscribeRequest{
		Model: "paraformer-v2",
		Input: fileTranscribeInput{
			FileURLs: []string{cfg.FileURL},
		},
		Parameters: transcribeParams{
			ChannelID:          []int{0},
			DiarizationEnabled: cfg.DiarizationEnabled,
			SpeakerCount:       cfg.SpeakerCount,
		},
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal transcribe request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, FileTranscribeEndpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("create transcribe request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-DashScope-Async", "enable")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("submit transcribe task: %w", err)
	}
	defer resp.Body.Close()

	var result fileTranscribeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode transcribe response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("transcribe submission failed with HTTP %d", resp.StatusCode)
	}
	if result.Output.TaskID == "" {
		return "", fmt.Errorf("no task_id in response")
	}
	return result.Output.TaskID, nil
}

func WaitForTranscription(ctx context.Context, apiKey string, taskID string, timeout time.Duration) (*TranscriptionResult, error) {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}

	deadline := time.Now().Add(timeout)
	pollInterval := 500 * time.Millisecond

	for {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("transcription timed out after %v", timeout)
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pollInterval):
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, TaskQueryEndpoint+"/"+taskID, nil)
		if err != nil {
			return nil, fmt.Errorf("create query request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("query task status: %w", err)
		}

		var result taskQueryResponse
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			resp.Body.Close()
			return nil, fmt.Errorf("decode query response: %w", err)
		}
		resp.Body.Close()

		switch result.Output.TaskStatus {
		case "SUCCEEDED":
			return fetchTranscriptionResult(ctx, result.Output.Results)
		case "FAILED", "ERROR":
			return nil, fmt.Errorf("transcription task %s", result.Output.TaskStatus)
		case "PENDING", "RUNNING":
			continue
		default:
			return nil, fmt.Errorf("unknown task status: %s", result.Output.TaskStatus)
		}
	}
}

func fetchTranscriptionResult(ctx context.Context, results []taskQueryResultItem) (*TranscriptionResult, error) {
	for _, item := range results {
		if item.SubtaskStatus != "SUCCEEDED" || item.TranscriptionURL == "" {
			continue
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, item.TranscriptionURL, nil)
		if err != nil {
			continue
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		var file transcriptionFile
		if err := json.NewDecoder(resp.Body).Decode(&file); err != nil {
			continue
		}

		var sentences []SentenceResult
		for _, transcript := range file.Transcripts {
			for _, s := range transcript.Sentences {
				sentences = append(sentences, SentenceResult{
					Text:      strings.TrimSpace(s.Text),
					SpeakerID: s.SpeakerID,
					BeginTime: s.BeginTime,
					EndTime:   s.EndTime,
				})
			}
		}
		return &TranscriptionResult{Sentences: sentences}, nil
	}
	return nil, fmt.Errorf("no successful transcription results found")
}
