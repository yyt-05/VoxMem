package asr

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func withMockHTTPClient(t *testing.T, fn roundTripFunc) {
	t.Helper()
	originalClient := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: fn}
	t.Cleanup(func() {
		http.DefaultClient = originalClient
	})
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestSubmitFileTranscriptionRequestsSpeakerDiarization(t *testing.T) {
	withMockHTTPClient(t, func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodPost || req.URL.String() != FileTranscribeEndpoint {
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.String())
		}
		if got := req.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("unexpected authorization header: %q", got)
		}
		if got := req.Header.Get("X-DashScope-Async"); got != "enable" {
			t.Fatalf("unexpected async header: %q", got)
		}

		var payload fileTranscribeRequest
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload.Model != "paraformer-v2" {
			t.Fatalf("unexpected model: %q", payload.Model)
		}
		if len(payload.Input.FileURLs) != 1 || payload.Input.FileURLs[0] != "https://cdn.example.com/audio.wav" {
			t.Fatalf("unexpected file urls: %+v", payload.Input.FileURLs)
		}
		if !payload.Parameters.DiarizationEnabled {
			t.Fatal("expected diarization to be enabled")
		}
		if payload.Parameters.SpeakerCount != 2 {
			t.Fatalf("expected speaker_count to default to 2, got %d", payload.Parameters.SpeakerCount)
		}

		return jsonResponse(http.StatusOK, `{"output":{"task_status":"PENDING","task_id":"task-1"},"request_id":"req-1"}`), nil
	})

	taskID, err := SubmitFileTranscription(context.Background(), FileTranscribeConfig{
		APIKey:             "test-key",
		FileURL:            "https://cdn.example.com/audio.wav",
		DiarizationEnabled: true,
	})
	if err != nil {
		t.Fatalf("submit file transcription: %v", err)
	}
	if taskID != "task-1" {
		t.Fatalf("unexpected task id: %q", taskID)
	}
}

func TestWaitForTranscriptionParsesSpeakerSentences(t *testing.T) {
	transcriptURL := "https://transcripts.example.com/result.json"
	withMockHTTPClient(t, func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case TaskQueryEndpoint + "/task-1":
			if got := req.Header.Get("Authorization"); got != "Bearer test-key" {
				t.Fatalf("unexpected authorization header: %q", got)
			}
			return jsonResponse(http.StatusOK, `{"output":{"task_status":"SUCCEEDED","task_id":"task-1","results":[{"subtask_status":"SUCCEEDED","transcription_url":"`+transcriptURL+`"}]}}`), nil
		case transcriptURL:
			return jsonResponse(http.StatusOK, `{"transcripts":[{"sentences":[{"text":" 本人第一句。 ","speaker_id":1,"begin_time":0,"end_time":1000},{"text":"旁人插话。","speaker_id":2,"begin_time":1000,"end_time":2000},{"text":"本人第二句。","speaker_id":1,"begin_time":2000,"end_time":3000}]}]}`), nil
		default:
			t.Fatalf("unexpected request URL: %s", req.URL.String())
			return nil, nil
		}
	})

	result, err := WaitForTranscription(context.Background(), "test-key", "task-1", time.Second)
	if err != nil {
		t.Fatalf("wait for transcription: %v", err)
	}
	if len(result.Sentences) != 3 {
		t.Fatalf("expected 3 sentences, got %+v", result.Sentences)
	}
	if result.Sentences[0].Text != "\u672c\u4eba\u7b2c\u4e00\u53e5\u3002" || result.Sentences[0].SpeakerID != 1 {
		t.Fatalf("unexpected first sentence: %+v", result.Sentences[0])
	}
	if result.Sentences[1].Text != "\u65c1\u4eba\u63d2\u8bdd\u3002" || result.Sentences[1].SpeakerID != 2 {
		t.Fatalf("unexpected second sentence: %+v", result.Sentences[1])
	}
	if result.Sentences[2].SpeakerID != 1 {
		t.Fatalf("unexpected third speaker id: %+v", result.Sentences[2])
	}
}
