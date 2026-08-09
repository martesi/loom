// Package webauth implements a minimal shared-secret gate for Loom's server
// mode: a single operator-controlled token, handed to a browser once via a
// "?token=" link and remembered afterwards via a cookie. This is not
// multi-user auth — anyone exposing server mode to a network they don't
// trust is responsible for layering real protection (TLS termination, a
// reverse-proxy auth layer, etc.) in front of it themselves.
package webauth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
)

const cookieName = "loom_token"

// Gate holds the shared secret that server mode is gated behind.
type Gate struct {
	token string
}

// NewGate builds a Gate from the LOOM_TOKEN environment variable, or a
// freshly generated random token if it's unset.
func NewGate() (*Gate, error) {
	if v := os.Getenv("LOOM_TOKEN"); v != "" {
		return &Gate{token: v}, nil
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("generate token: %w", err)
	}
	return &Gate{token: hex.EncodeToString(buf)}, nil
}

// Token returns the shared secret this Gate checks requests against.
func (g *Gate) Token() string {
	return g.token
}

// Middleware gates every request behind the Gate's token: a valid session
// cookie lets the request through unchanged; a valid "?token=" query
// parameter sets that cookie and redirects to the same URL with the
// parameter stripped, so the token doesn't linger in the address bar,
// browser history, or referrer headers past the first load. Anything else
// is rejected outright.
func (g *Gate) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cookie, err := r.Cookie(cookieName); err == nil && g.valid(cookie.Value) {
			next.ServeHTTP(w, r)
			return
		}

		query := r.URL.Query()
		if provided := query.Get("token"); provided != "" && g.valid(provided) {
			http.SetCookie(w, &http.Cookie{
				Name:     cookieName,
				Value:    g.token,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
				MaxAge:   400 * 24 * 60 * 60, // ~400 days: the practical browser maximum
			})

			query.Del("token")
			redirectURL := *r.URL
			redirectURL.RawQuery = query.Encode()
			http.Redirect(w, r, redirectURL.String(), http.StatusFound)
			return
		}

		http.Error(w, "Unauthorized. Open the link printed at server startup (?token=...) to log in.", http.StatusUnauthorized)
	})
}

func (g *Gate) valid(candidate string) bool {
	return subtle.ConstantTimeCompare([]byte(candidate), []byte(g.token)) == 1
}
