package webauth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func testGate() *Gate {
	return &Gate{token: "correct-token"}
}

func passthrough() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestMiddleware_NoCredentials_Unauthorized(t *testing.T) {
	g := testGate()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/board", nil)

	g.Middleware(passthrough()).ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestMiddleware_HealthIsPublic(t *testing.T) {
	g := testGate()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	g.Middleware(passthrough()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestMiddleware_WrongToken_Unauthorized(t *testing.T) {
	g := testGate()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/?token=nope", nil)

	g.Middleware(passthrough()).ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestMiddleware_CorrectToken_SetsCookieAndRedirectsWithoutToken(t *testing.T) {
	g := testGate()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/board?repo=foo&token=correct-token", nil)

	g.Middleware(passthrough()).ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusFound)
	}

	location := rec.Header().Get("Location")
	if location != "/board?repo=foo" {
		t.Fatalf("Location = %q, want %q", location, "/board?repo=foo")
	}

	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("got %d cookies, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != cookieName || cookie.Value != "correct-token" {
		t.Fatalf("cookie = %+v, want name=%q value=%q", cookie, cookieName, "correct-token")
	}
	if !cookie.HttpOnly {
		t.Fatal("cookie must be HttpOnly")
	}
}

func TestMiddleware_ValidCookie_PassesThrough(t *testing.T) {
	g := testGate()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/board", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "correct-token"})

	g.Middleware(passthrough()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestMiddleware_InvalidCookie_Unauthorized(t *testing.T) {
	g := testGate()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/board", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "stale-token"})

	g.Middleware(passthrough()).ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestMiddleware_EventWebSocketRejectsCrossOrigin(t *testing.T) {
	g := testGate()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://localhost:8080/wails/events", nil)
	req.Host = "localhost:8080"
	req.Header.Set("Origin", "https://evil.example")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "correct-token"})

	g.Middleware(passthrough()).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestMiddleware_EventWebSocketAllowsSameOriginCookie(t *testing.T) {
	g := testGate()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://localhost:8080/wails/events", nil)
	req.Host = "localhost:8080"
	req.Header.Set("Origin", "http://localhost:8080")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "correct-token"})

	g.Middleware(passthrough()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestNewGate_UsesEnvToken(t *testing.T) {
	t.Setenv("LOOM_TOKEN", "env-token")

	g, err := NewGate()
	if err != nil {
		t.Fatalf("NewGate() error = %v", err)
	}
	if g.Token() != "env-token" {
		t.Fatalf("Token() = %q, want %q", g.Token(), "env-token")
	}
}

func TestNewGate_GeneratesTokenWhenEnvUnset(t *testing.T) {
	g, err := NewGate()
	if err != nil {
		t.Fatalf("NewGate() error = %v", err)
	}
	if len(g.Token()) != 64 { // 32 random bytes, hex-encoded
		t.Fatalf("Token() length = %d, want 64", len(g.Token()))
	}
}
