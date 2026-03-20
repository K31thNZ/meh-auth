// client/src/pages/login.tsx
// SHARED — use this in BOTH Event-Hub and MRDC frontends.
// Change AUTH_URL and APP_NAME per project via env vars.
//
// Env vars needed in each Vercel project:
//   VITE_AUTH_URL=https://meh-auth.up.railway.app
//   VITE_APP_NAME=ExpatEvents        (or "Games in English")
//   VITE_TELEGRAM_BOT_NAME=YourBotUsername

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const AUTH_URL = import.meta.env.VITE_AUTH_URL ?? "https://meh-auth.up.railway.app";
const APP_NAME = import.meta.env.VITE_APP_NAME ?? "MEH Moscow";
const BOT_NAME = import.meta.env.VITE_TELEGRAM_BOT_NAME ?? "";

// Each OAuth button redirects to the auth service, passing this app's
// URL so the auth service knows where to redirect back after login.
function oauthUrl(provider: string) {
  const returnTo = encodeURIComponent(window.location.origin);
  return `${AUTH_URL}/api/auth/${provider}?returnTo=${returnTo}`;
}

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const loginMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${AUTH_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error("Login failed");
      return res.json();
    },
    onSuccess: () => setLocation("/"),
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-2xl">{APP_NAME}</CardTitle>
          <p className="text-center text-sm text-muted-foreground">
            Sign in to continue
          </p>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* ── Google ────────────────────────────────────── */}
          <Button variant="outline" className="w-full gap-2"
            onClick={() => window.location.href = oauthUrl("google")}>
            <GoogleIcon />
            Continue with Google
          </Button>

          {/* ── Yandex ───────────────────────────────────── */}
          <Button variant="outline" className="w-full gap-2"
            onClick={() => window.location.href = oauthUrl("yandex")}>
            <YandexIcon />
            Continue with Yandex
          </Button>

          {/* ── Apple ────────────────────────────────────── */}
          <Button variant="outline" className="w-full gap-2"
            onClick={() => window.location.href = oauthUrl("apple")}>
            <AppleIcon />
            Continue with Apple
          </Button>

          {/* ── Telegram ─────────────────────────────────── */}
          {BOT_NAME && <TelegramButton botName={BOT_NAME} />}

          <div className="relative">
            <div className="absolute inset-0 flex items-center"><Separator /></div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">or username</span>
            </div>
          </div>

          {/* ── Username / password ───────────────────────── */}
          <div className="space-y-2">
            <div>
              <Label htmlFor="username">Username</Label>
              <Input id="username" value={username}
                onChange={e => setUsername(e.target.value)}
                onKeyDown={e => e.key === "Enter" && loginMutation.mutate()} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === "Enter" && loginMutation.mutate()} />
            </div>
            {loginMutation.isError && (
              <p className="text-sm text-destructive">Incorrect username or password.</p>
            )}
            <Button className="w-full" onClick={() => loginMutation.mutate()}
              disabled={loginMutation.isPending || !username || !password}>
              {loginMutation.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </div>

          <p className="text-center text-sm text-muted-foreground">
            No account? <a href="/register" className="underline">Register</a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Telegram Widget ───────────────────────────────────────────────────────
function TelegramButton({ botName }: { botName: string }) {
  useState(() => {
    if (document.getElementById("tg-script")) return;
    const s = document.createElement("script");
    s.id = "tg-script";
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.setAttribute("data-telegram-login", botName);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-auth-url", `${AUTH_URL}/api/auth/telegram`);
    s.setAttribute("data-request-access", "write");
    s.async = true;
    document.getElementById("tg-container")?.appendChild(s);
  });
  return <div id="tg-container" className="flex justify-center" />;
}

// ── Icons ─────────────────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

function YandexIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#FC3F1D" d="M2 0h20a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2z"/>
      <path fill="#fff" d="M13.32 4H10.9C8.1 4 6.5 5.46 6.5 7.93c0 2.18 1.06 3.4 3.08 4.73L7 20h2.7l2.78-7.05-.6-.37C10.1 11.4 9.2 10.5 9.2 7.93c0-1.55.92-2.46 2.72-2.46h1.4V20H16V4h-2.68z"/>
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"/>
    </svg>
  );
}
