package audiodebug

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRecorderWritesPCMAndWAV(t *testing.T) {
	recorder, err := NewRecorder(t.TempDir(), "task-1", 16000)
	if err != nil {
		t.Fatalf("NewRecorder() error = %v", err)
	}

	if err := recorder.Write([]byte{0x00, 0x00, 0xff, 0x7f}); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	pcmPath, wavPath, bytesWritten, err := recorder.Close()
	if err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if bytesWritten != 4 {
		t.Fatalf("bytesWritten = %d, want 4", bytesWritten)
	}

	pcm, err := os.ReadFile(pcmPath)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", pcmPath, err)
	}
	if len(pcm) != 4 {
		t.Fatalf("pcm size = %d, want 4", len(pcm))
	}

	wav, err := os.ReadFile(wavPath)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", wavPath, err)
	}
	if len(wav) != 48 {
		t.Fatalf("wav size = %d, want 48", len(wav))
	}
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		t.Fatalf("wav header = %q %q, want RIFF WAVE", wav[0:4], wav[8:12])
	}
	if filepath.Base(wavPath) != "task-1.wav" {
		t.Fatalf("wav path = %q, want task-1.wav suffix", wavPath)
	}
}
