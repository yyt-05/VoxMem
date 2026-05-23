package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/yyt-05/VoxMem/server/internal/asr"
	"github.com/yyt-05/VoxMem/server/internal/localenv"
)

func main() {
	var (
		audioPath  = flag.String("audio", "", "Path to a mono audio file to recognize. Use 16kHz PCM for the default flags.")
		checkOnly  = flag.Bool("check-only", false, "Only verify WebSocket authentication and task lifecycle without audio.")
		endpoint   = flag.String("endpoint", getenv("VOXMEM_ASR_ENDPOINT", asr.DefaultEndpoint), "DashScope WebSocket endpoint.")
		model      = flag.String("model", getenv("VOXMEM_ASR_MODEL", asr.DefaultModel), "ASR model name.")
		format     = flag.String("format", asr.DefaultFormat, "Audio format, such as pcm or wav.")
		sampleRate = flag.Int("sample-rate", asr.DefaultSampleRate, "Audio sample rate in Hz.")
		chunkSize  = flag.Int("chunk-size", asr.DefaultChunkSize, "Audio bytes sent per WebSocket binary frame.")
		timeout    = flag.Duration("timeout", 45*time.Second, "Probe timeout.")
	)
	flag.Parse()

	if err := localenv.LoadFiles(".env", ".env.local", "../.env", "../.env.local"); err != nil {
		exitf("load env: %v", err)
	}

	cfg := asr.Config{
		APIKey:     os.Getenv("DASHSCOPE_API_KEY"),
		Endpoint:   *endpoint,
		Model:      *model,
		Format:     *format,
		SampleRate: *sampleRate,
		ChunkSize:  *chunkSize,
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	var (
		result *asr.ProbeResult
		err    error
	)
	if *checkOnly {
		result, err = asr.CheckTask(ctx, cfg)
	} else {
		if *audioPath == "" {
			exitf("missing -audio. Use -check-only to verify only authentication and task lifecycle.")
		}
		result, err = asr.RecognizeFile(ctx, cfg, *audioPath)
	}
	if err != nil {
		exitf("%v", err)
	}

	fmt.Printf("task_id=%s\n", result.TaskID)
	fmt.Printf("started=%t finished=%t\n", result.Started, result.Finished)
	if result.AudioBytes > 0 {
		fmt.Printf("audio_bytes=%d audio_send_duration=%s\n", result.AudioBytes, result.AudioDuration.Round(time.Millisecond))
	}
	for _, event := range result.Events {
		fmt.Printf("event=%s\n", event.Header.Event)
	}
	if result.FinalText != "" {
		fmt.Printf("final_text=%s\n", result.FinalText)
	}
}

func getenv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func exitf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "asr-probe: "+format+"\n", args...)
	os.Exit(1)
}
