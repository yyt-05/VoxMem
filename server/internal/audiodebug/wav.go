package audiodebug

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
)

type Recorder struct {
	sampleRate int
	pcmPath    string
	wavPath    string
	file       *os.File
	bytes      int64
}

func NewRecorder(dir string, sessionID string, sampleRate int) (*Recorder, error) {
	if dir == "" {
		dir = filepath.Join("..", "tmp", "audio-debug")
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve audio debug dir: %w", err)
	}
	dir = absDir
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create audio debug dir: %w", err)
	}

	fileName := filepath.Base(sessionID)
	if fileName == "." || fileName == string(filepath.Separator) {
		fileName = "audio-debug"
	}
	pcmPath := filepath.Join(dir, fileName+".pcm")
	wavPath := filepath.Join(dir, fileName+".wav")
	file, err := os.Create(pcmPath)
	if err != nil {
		return nil, fmt.Errorf("create debug pcm: %w", err)
	}

	return &Recorder{
		sampleRate: sampleRate,
		pcmPath:    pcmPath,
		wavPath:    wavPath,
		file:       file,
	}, nil
}

func (r *Recorder) Write(data []byte) error {
	if r == nil || r.file == nil || len(data) == 0 {
		return nil
	}
	n, err := r.file.Write(data)
	r.bytes += int64(n)
	if err != nil {
		return fmt.Errorf("write debug pcm: %w", err)
	}
	return nil
}

func (r *Recorder) Close() (string, string, int64, error) {
	if r == nil || r.file == nil {
		return "", "", 0, nil
	}

	if err := r.file.Close(); err != nil {
		return r.pcmPath, r.wavPath, r.bytes, fmt.Errorf("close debug pcm: %w", err)
	}
	r.file = nil

	if err := writeWAV(r.wavPath, r.pcmPath, r.bytes, r.sampleRate); err != nil {
		return r.pcmPath, r.wavPath, r.bytes, err
	}
	return r.pcmPath, r.wavPath, r.bytes, nil
}

func writeWAV(wavPath string, pcmPath string, pcmBytes int64, sampleRate int) error {
	pcm, err := os.ReadFile(pcmPath)
	if err != nil {
		return fmt.Errorf("read debug pcm: %w", err)
	}

	wav, err := os.Create(wavPath)
	if err != nil {
		return fmt.Errorf("create debug wav: %w", err)
	}
	defer wav.Close()

	const (
		channels      = 1
		bitsPerSample = 16
		audioFormat   = 1
	)

	byteRate := sampleRate * channels * bitsPerSample / 8
	blockAlign := channels * bitsPerSample / 8
	dataSize := uint32(pcmBytes)
	riffSize := uint32(36 + pcmBytes)

	if _, err := wav.Write([]byte("RIFF")); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, riffSize); err != nil {
		return err
	}
	if _, err := wav.Write([]byte("WAVEfmt ")); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, uint32(16)); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, uint16(audioFormat)); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, uint16(channels)); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, uint32(sampleRate)); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, uint32(byteRate)); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, uint16(blockAlign)); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, uint16(bitsPerSample)); err != nil {
		return err
	}
	if _, err := wav.Write([]byte("data")); err != nil {
		return err
	}
	if err := binary.Write(wav, binary.LittleEndian, dataSize); err != nil {
		return err
	}
	if _, err := wav.Write(pcm); err != nil {
		return err
	}
	return nil
}
