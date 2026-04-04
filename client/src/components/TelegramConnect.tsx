// client/src/components/TelegramConnect.tsx
// Drop this component into Profile.tsx where the Telegram section is.
// Replaces the "copy your profile ID" instructions with a one-tap deep link button.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Unlink, Loader2 } from "lucide-react";

const AUTH_URL = import.meta.env.VITE_AUTH_URL ?? "https://auth.expatevents.org";

interface TelegramConnectProps {
  connected: boolean;        // whether user already has telegramId
  onUnlinked?: () => void;   // callback after successful unlink
}

export function TelegramConnect({ connected, onUnlinked }: TelegramConnectProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${AUTH_URL}/api/telegram/link-token`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to generate link. Please try again.");
        return;
      }

      const { deepLink } = await res.json();
      // Open the Telegram deep link — on mobile this opens the Telegram app directly
      window.open(deepLink, "_blank");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    setError(null);
    try {
      await fetch(`${AUTH_URL}/api/telegram/unlink`, {
        method: "POST",
        credentials: "include",
      });
      onUnlinked?.();
    } catch {
      setError("Failed to unlink. Please try again.");
    } finally {
      setUnlinking(false);
    }
  };

  if (connected) {
    return (
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-950 flex items-center justify-center text-lg">
            ✈️
          </div>
          <div>
            <p className="font-medium text-sm">Telegram connected</p>
            <p className="text-xs text-muted-foreground">
              You'll receive event notifications via Telegram
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">Connected</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleUnlink}
            disabled={unlinking}
            className="text-muted-foreground hover:text-destructive text-xs h-7 px-2"
          >
            {unlinking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unlink className="w-3 h-3 mr-1" />}
            Unlink
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Connect Telegram to get event notifications and availability alerts
        directly in your phone — no app to check, no emails to miss.
      </p>

      <Button
        onClick={handleConnect}
        disabled={loading}
        className="w-full gap-2 rounded-xl"
        variant="outline"
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <ExternalLink className="w-4 h-4" />
        )}
        {loading ? "Generating link…" : "Connect Telegram"}
      </Button>

      {error && (
        <p className="text-xs text-destructive text-center">{error}</p>
      )}

      <p className="text-xs text-muted-foreground text-center">
        Tapping the button opens Telegram. The bot will confirm once your accounts are linked.
      </p>
    </div>
  );
}
