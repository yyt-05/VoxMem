package asr

import "testing"

func TestConfigWithDefaults(t *testing.T) {
	cfg, err := Config{APIKey: "test-key"}.withDefaults()
	if err != nil {
		t.Fatalf("withDefaults returned error: %v", err)
	}

	if cfg.Endpoint != DefaultEndpoint {
		t.Fatalf("expected endpoint %q, got %q", DefaultEndpoint, cfg.Endpoint)
	}
	if cfg.Model != DefaultModel {
		t.Fatalf("expected model %q, got %q", DefaultModel, cfg.Model)
	}
	if cfg.Format != DefaultFormat {
		t.Fatalf("expected format %q, got %q", DefaultFormat, cfg.Format)
	}
	if cfg.SampleRate != DefaultSampleRate {
		t.Fatalf("expected sample rate %d, got %d", DefaultSampleRate, cfg.SampleRate)
	}
	if cfg.ChunkSize != DefaultChunkSize {
		t.Fatalf("expected chunk size %d, got %d", DefaultChunkSize, cfg.ChunkSize)
	}
}

func TestConfigWithDefaultsRequiresAPIKey(t *testing.T) {
	if _, err := (Config{}).withDefaults(); err == nil {
		t.Fatal("expected missing API key error")
	}
}

func TestRunTaskMessageShape(t *testing.T) {
	msg := runTaskMessage("task-1", Config{
		Model:      "paraformer-realtime-v2",
		Format:     "pcm",
		SampleRate: 16000,
	})

	header := msg["header"].(map[string]any)
	if header["action"] != "run-task" {
		t.Fatalf("expected run-task action, got %v", header["action"])
	}
	if header["streaming"] != "duplex" {
		t.Fatalf("expected duplex streaming, got %v", header["streaming"])
	}

	payload := msg["payload"].(map[string]any)
	if payload["task_group"] != "audio" {
		t.Fatalf("expected audio task group, got %v", payload["task_group"])
	}
	if payload["model"] != "paraformer-realtime-v2" {
		t.Fatalf("expected paraformer model, got %v", payload["model"])
	}

	params := payload["parameters"].(map[string]any)
	if params["format"] != "pcm" {
		t.Fatalf("expected pcm format, got %v", params["format"])
	}
	if params["sample_rate"] != 16000 {
		t.Fatalf("expected sample rate 16000, got %v", params["sample_rate"])
	}
}
