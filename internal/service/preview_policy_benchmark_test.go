package service

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Run with: go test ./internal/service -run '^$' -bench '^BenchmarkPreviewPolicy$' -benchtime=3x -count=1
// The generated sources are procedural FFmpeg patterns; no binary fixtures are checked in.
func BenchmarkPreviewPolicy(b *testing.B) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		b.Skip("ffmpeg is required for preview policy measurements")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		b.Skip("ffprobe is required for preview policy measurements")
	}
	root := b.TempDir()
	fixtures := []struct {
		name   string
		filter string
		video  bool
	}{
		{name: "landscape", filter: "testsrc2=size=2560x1440:rate=1"},
		{name: "portrait", filter: "testsrc2=size=1440x2560:rate=1"},
		{name: "large", filter: "testsrc2=size=6000x4000:rate=1"},
		{name: "video", filter: "testsrc2=size=3840x2160:rate=24:duration=3", video: true},
	}
	tiers := []int{320, 640, 1280, 2048, 3072}
	for _, fixture := range fixtures {
		ext := ".png"
		if fixture.video {
			ext = ".mp4"
		}
		source := filepath.Join(root, fixture.name+ext)
		args := []string{"-y", "-f", "lavfi", "-i", fixture.filter, "-frames:v", "1"}
		if fixture.video {
			args = []string{"-y", "-f", "lavfi", "-i", fixture.filter, "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"}
		}
		if err := exec.Command("ffmpeg", append(args, source)...).Run(); err != nil {
			b.Fatalf("generate %s fixture: %v", fixture.name, err)
		}
		for _, tier := range tiers {
			if fixture.video && tier != 320 {
				continue // Current video preview path is intentionally thumbnail-only.
			}
			name := fmt.Sprintf("%s/%d", fixture.name, tier)
			output := filepath.Join(root, fixture.name+"-"+strconv.Itoa(tier)+".webp")
			encode := func(destination string) (int64, int64, error) {
				if tier <= 2048 {
					ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
					defer cancel()
					peak, err := runPreviewWithPeakRSS(ctx, source, destination, tier, fixture.video)
					if err != nil {
						return 0, peak, err
					}
					info, err := os.Stat(destination)
					if err != nil {
						return 0, peak, err
					}
					return info.Size(), peak, nil
				}
				peak, err := runCandidatePreviewWithPeakRSS(source, destination, tier)
				if err != nil {
					return 0, peak, err
				}
				info, err := os.Stat(destination)
				if err != nil {
					return 0, peak, err
				}
				return info.Size(), peak, nil
			}
			b.Run(name+"/cold-encode", func(b *testing.B) {
				var bytes, peak int64
				for i := 0; i < b.N; i++ {
					destination := filepath.Join(root, fmt.Sprintf("cold-%s-%d.webp", strings.ReplaceAll(name, "/", "-"), i))
					var err error
					bytes, peak, err = encode(destination)
					if err != nil {
						b.Fatal(err)
					}
					_ = os.Remove(destination)
				}
				b.ReportMetric(float64(bytes), "output-B")
				b.ReportMetric(float64(peak)/(1024*1024), "peak-MiB")
			})
			if _, _, err := encode(output); err != nil {
				b.Fatalf("prime %s output: %v", name, err)
			}
			b.Run(name+"/warm-cache-read", func(b *testing.B) {
				var bytes int64
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					data, err := os.ReadFile(output)
					if err != nil {
						b.Fatal(err)
					}
					bytes = int64(len(data))
				}
				b.ReportMetric(float64(bytes), "output-B")
			})
		}
	}
}

// runPreviewWithPeakRSS polls the encoder process RSS. It reports the peak of the
// FFmpeg process only, not Go, the desktop app, or kernel page cache.
func runPreviewWithPeakRSS(ctx context.Context, source, destination string, tier int, video bool) (int64, error) {
	if _, err := os.Stat(source); err != nil {
		return 0, err
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", previewArgs(source, destination, tier, video)...)
	return runCommandWithPeakRSS(cmd)
}

func runCandidatePreviewWithPeakRSS(source, destination string, tier int) (int64, error) {
	cmd := exec.Command("ffmpeg", previewArgs(source, destination, tier, false)...)
	return runCommandWithPeakRSS(cmd)
}

func previewArgs(source, destination string, tier int, video bool) []string {
	args := []string{"-y"}
	if video {
		args = append(args, "-ss", "1.500")
	}
	return append(args, "-i", source, "-vf", fmt.Sprintf("scale='min(iw,%d)':'min(ih,4096)':force_original_aspect_ratio=decrease", tier), "-frames:v", "1", "-c:v", "libwebp", "-quality", "70", destination)
}

func runCommandWithPeakRSS(cmd *exec.Cmd) (int64, error) {
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	var peak int64
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	for {
		select {
		case err := <-done:
			return peak, err
		default:
			if rss := processRSSBytes(cmd.Process.Pid); rss > peak {
				peak = rss
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
}

func processRSSBytes(pid int) int64 {
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(status), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0
		}
		kib, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			return 0
		}
		return kib * 1024
	}
	return 0
}
