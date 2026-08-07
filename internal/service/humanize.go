package service

import (
	"fmt"
	"time"
)

// relativeTime renders t as a short "Opened ..." phrase, matching the
// mockup's "Opened 2 hours ago" / "Opened yesterday" / "Opened 5 days ago".
func relativeTime(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "Opened just now"
	case d < time.Hour:
		mins := int(d / time.Minute)
		return fmt.Sprintf("Opened %d minute%s ago", mins, plural(mins))
	case d < 24*time.Hour:
		hours := int(d / time.Hour)
		return fmt.Sprintf("Opened %d hour%s ago", hours, plural(hours))
	case d < 48*time.Hour:
		return "Opened yesterday"
	case d < 7*24*time.Hour:
		days := int(d / (24 * time.Hour))
		return fmt.Sprintf("Opened %d days ago", days)
	default:
		return "Opened " + t.Format("Jan 2, 2006")
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
