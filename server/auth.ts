// App.tsx
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Groups from "@/pages/Groups";
import GroupProfile from "@/pages/GroupProfile";
import CreateGroup from "@/pages/CreateGroup";
import GroupManage from "@/pages/GroupManage";
import { Navbar } from "@/components/layout/Navbar";
import Home from "@/pages/Home";
import EventDetails from "@/pages/EventDetails";
import Dashboard from "@/pages/Dashboard";
import CreateEvent from "@/pages/CreateEvent";
import OrderView from "@/pages/OrderView";
import Profile from "@/pages/Profile";
import { useAuth } from "@/hooks/use-auth";
import Picks from "@/pages/Picks";
import PitchDeck from "./pages/PitchDeck";
import { useTelegramMiniAppAuth } from "@/hooks/use-telegram-miniapp-auth";

const AUTH_URL = import.meta.env.VITE_AUTH_URL ?? "https://auth.expatevents.org";

// Loading spinner component
const FullPageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
  </div>
);

// ── Protected Route Wrapper ───────────────────────────────────────────────
function ProtectedRoute({ component: Component }: { component: any }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <FullPageLoader />;
  if (!isAuthenticated) {
    // Redirect to auth service login with returnTo
    window.location.href = `${AUTH_URL}/login?returnTo=${encodeURIComponent(window.location.href)}`;
    return null;
  }
  return <Component />;
}

// ── Router ────────────────────────────────────────────────────────────────
function Router() {
  const [location] = useLocation();

  // Pitch deck renders without navbar/layout
  if (location === "/pitch") {
    return <PitchDeck />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-background font-sans">
      <Navbar />
      <main className="flex-1 flex flex-col">
        <Switch>
          {/* ── General ─────────────────────────────────────────────── */}
          <Route path="/" component={Home} />
          <Route path="/picks" component={Picks} />
          <Route path="/profile">
            <ProtectedRoute component={Profile} />
          </Route>

          {/* ── Events ──────────────────────────────────────────────── */}
          <Route path="/create-event">
            <ProtectedRoute component={CreateEvent} />
          </Route>
          <Route path="/events/:id" component={EventDetails} />

          {/* ── Orders ──────────────────────────────────────────────── */}
          <Route path="/orders/:id">
            <ProtectedRoute component={OrderView} />
          </Route>

          {/* ── Dashboard ───────────────────────────────────────────── */}
          <Route path="/dashboard">
            <ProtectedRoute component={Dashboard} />
          </Route>

          {/* ── Groups ──────────────────────────────────────────────── */}
          {/* IMPORTANT: specific paths must come before /:slug         */}
          <Route path="/groups" component={Groups} />
          <Route path="/groups/create">
            <ProtectedRoute component={CreateGroup} />
          </Route>

          {/* /groups/:slug/create-event — pre-links the event to the group */}
          <Route path="/groups/:slug/create-event">
            {(params) => (
              <ProtectedRoute component={() => <CreateEvent groupSlug={params.slug} />} />
            )}
          </Route>

          {/* /groups/:slug/manage — edit group settings */}
          <Route path="/groups/:slug/manage">
            <ProtectedRoute component={GroupManage} />
          </Route>

          {/* /groups/:slug — public group profile (must be last of the group routes) */}
          <Route path="/groups/:slug" component={GroupProfile} />

          {/* ── Fallback ─────────────────────────────────────────────── */}
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}

// ── Authentication Gate ───────────────────────────────────────────────────
// Waits for Mini App auth (if applicable) and user session to be ready.
function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticating: isMiniAppAuth } = useTelegramMiniAppAuth();
  const { isLoading: isAuthLoading } = useAuth();

  if (isMiniAppAuth || isAuthLoading) {
    return <FullPageLoader />;
  }

  return <>{children}</>;
}

// ── App ───────────────────────────────────────────────────────────────────
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthGate>
          <Router />
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
