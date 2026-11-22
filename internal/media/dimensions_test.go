package media

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestSourceDimensionsParsesStillImageHeaders(t *testing.T) {
	tests := []struct {
		name  string
		write func(*testing.T, string)
		want  Dimensions
	}{
		{"png", func(t *testing.T, path string) {
			writeEncoded(t, path, func(w *bytes.Buffer) error { return png.Encode(w, image.NewRGBA(image.Rect(0, 0, 13, 7))) })
		}, Dimensions{13, 7}},
		{"jpeg", func(t *testing.T, path string) {
			writeEncoded(t, path, func(w *bytes.Buffer) error { return jpeg.Encode(w, image.NewRGBA(image.Rect(0, 0, 13, 7)), nil) })
		}, Dimensions{13, 7}},
		{"gif", func(t *testing.T, path string) {
			writeEncoded(t, path, func(w *bytes.Buffer) error {
				return gif.Encode(w, image.NewPaletted(image.Rect(0, 0, 13, 7), colorPalette()), nil)
			})
		}, Dimensions{13, 7}},
		{"webp", writeVP8X, Dimensions{320, 180}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fixture."+test.name)
			test.write(t, path)
			got, err := SourceDimensions(path)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("dimensions = %+v, want %+v", got, test.want)
			}
		})
	}
}

func writeEncoded(t *testing.T, path string, encode func(*bytes.Buffer) error) {
	t.Helper()
	var data bytes.Buffer
	if err := encode(&data); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func colorPalette() color.Palette { return color.Palette{color.Black, color.White} }

func writeVP8X(t *testing.T, path string) {
	t.Helper()
	var data bytes.Buffer
	data.WriteString("RIFF")
	_ = binary.Write(&data, binary.LittleEndian, uint32(22))
	data.WriteString("WEBPVP8X")
	_ = binary.Write(&data, binary.LittleEndian, uint32(10))
	data.Write([]byte{0, 0, 0, 0, 63, 1, 0, 179, 0, 0})
	if err := os.WriteFile(path, data.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}
