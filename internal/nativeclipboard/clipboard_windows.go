package nativeclipboard

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

func Write(paths []string) error {
	data, err := json.Marshal(paths)
	if err != nil {
		return err
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; $paths = [Console]::In.ReadToEnd() | ConvertFrom-Json; foreach ($p in $paths) { [void]$files.Add($p) }; [System.Windows.Forms.Clipboard]::SetFileDropList($files)`)
	cmd.Stdin = strings.NewReader(string(data))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("native file clipboard: %w: %s", err, out)
	}
	return nil
}
func Read() ([]string, error) {
	paths, _, err := ReadIntent()
	return paths, err
}

// ReadIntent reads the file list and preferred drop effect from one data
// object. Anything other than an unambiguous MOVE remains non-destructive.
func ReadIntent() ([]string, bool, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $item = [System.Windows.Forms.Clipboard]::GetDataObject(); $paths = @(); $move = $false; if ($null -ne $item -and $item.GetDataPresent('FileDrop', $false)) { $paths = @($item.GetData('FileDrop', $false)); $effect = $item.GetData('Preferred DropEffect', $false); if ($effect -is [System.IO.MemoryStream]) { $effect = $effect.ToArray() }; if ($effect -is [byte[]] -and $effect.Length -eq 4) { $move = [BitConverter]::ToUInt32($effect, 0) -eq 2 } }; ConvertTo-Json -Compress -InputObject @{ paths = $paths; move = $move }`)
	out, err := cmd.Output()
	if err != nil {
		return nil, false, err
	}
	var result struct {
		Paths []string `json:"paths"`
		Move  bool     `json:"move"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, false, err
	}
	return result.Paths, result.Move, nil
}
