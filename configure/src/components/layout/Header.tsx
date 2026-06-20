import { useEffect, useState } from 'react';
import { useConfig } from '../../contexts/ConfigContext';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { LogOut, Eye, EyeOff } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Header() {
  const { setConfig, resetConfig, auth, setAuth } = useConfig();
  const [authTransitioning, setAuthTransitioning] = useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [uuidInput, setUuidInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [uuidFromUrl, setUuidFromUrl] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [requireAddonPassword, setRequireAddonPassword] = useState(false);
  const [addonPasswordInput, setAddonPasswordInput] = useState("");
  const [isUUIDTrusted, setIsUUIDTrusted] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      if (window.location.pathname.includes('/configure')) {
        sessionStorage.setItem(
          'lastConfigureUrl',
          window.location.pathname + window.location.search + window.location.hash
        );
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const pathParts = window.location.pathname.split('/');
      const stremioIndex = pathParts.findIndex(p => p === 'stremio');
      if (stremioIndex !== -1 && pathParts[stremioIndex + 1]) {
        const potentialUUID = pathParts[stremioIndex + 1];
        if (potentialUUID.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          setUuidFromUrl(potentialUUID);
          setUuidInput(potentialUUID);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const isFromStremio = window.location.pathname.includes('/stremio/') || 
                           sessionStorage.getItem('fromStremioSettings') === 'true';
      
      // Don't prompt for login on dashboard route
      const isDashboardRoute = window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/';
      
      if (!auth.authenticated && isFromStremio && !isDashboardRoute) {
        sessionStorage.removeItem('fromStremioSettings');
        setTimeout(() => setIsLoginOpen(true), 100);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (window.location.pathname.includes('/stremio/')) {
      sessionStorage.setItem('fromStremioSettings', 'true');
    }
  }, []);

  useEffect(() => {
    fetch("/api/config/addon-info")
      .then(res => res.json())
      .then(data => setRequireAddonPassword(!!data.requiresAddonPassword))
      .catch(() => setRequireAddonPassword(false));
  }, []);

  useEffect(() => {
    if (uuidInput && uuidInput.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      fetch(`/api/config/is-trusted/${encodeURIComponent(uuidInput)}`)
        .then(res => res.json())
        .then(data => {
          setIsUUIDTrusted(!!data.trusted);
          setRequireAddonPassword(!!data.requiresAddonPassword);
        })
        .catch(() => {
          setIsUUIDTrusted(null);
          setRequireAddonPassword(false);
        });
    } else {
      setIsUUIDTrusted(null);
      setRequireAddonPassword(false);
    }
  }, [uuidInput]);

  const handleLogin = async () => {
    setIsLoading(true);
    setLoginError('');
    try {
      if (!uuidInput || !passwordInput) {
        setLoginError('UUID and password are required');
        setIsLoading(false);
        return;
      }
      const response = await fetch(`/api/config/load/${encodeURIComponent(uuidInput)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput, addonPassword: addonPasswordInput })
      });
      if (!response.ok) {
        let message = 'Failed to load configuration';
        try {
          const err = await response.json();
          message = err?.error || message;
        } catch {}
        throw new Error(message);
      }
      const result = await response.json();
      if (!result?.success || !result?.config) {
        throw new Error('Invalid response from server');
      }
      setConfig(prev => ({
        ...result.config,
        catalogSetupComplete: true,
        apiKeys: {
          ...result.config.apiKeys,
          customDescriptionBlurb: prev.apiKeys.customDescriptionBlurb,
        },
      }));
      setAuth({ authenticated: true, userUUID: uuidInput, password: passwordInput });
      toast.success('Configuration loaded');
      setIsLoginOpen(false);
      setUuidInput('');
      setPasswordInput('');
      setAddonPasswordInput('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load configuration';
      setLoginError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    setAuthTransitioning(true);
    setIsLoginOpen(false);
    await resetConfig();
    setAuth({ authenticated: false, userUUID: null, password: null });
    toast.success('Signed out and reset configuration');
    setTimeout(() => {
      setAuthTransitioning(false);
      window.location.href = '/configure';
    }, 300);
  };

  return (
    <header className="w-full py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col items-center sm:flex-row sm:items-center sm:space-x-4 gap-2 sm:gap-0">
          <div className="text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2 flex-wrap">
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
                AIO Addon
              </h1>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center sm:justify-end gap-2 sm:gap-3">
          <Button
            onClick={handleLogout}
            variant="outline"
            size="sm"
            aria-label="Logout"
            title="Logout"
            disabled={authTransitioning}
            className="gap-2"
          >
            <LogOut className="h-4 w-4" />
            <span>Logout</span>
          </Button>
        </div>
      </div>

      <Dialog
        open={isLoginOpen}
        onOpenChange={(next) => {
          if (authTransitioning) return;
          setIsLoginOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Load Saved Configuration</DialogTitle>
            <DialogDescription>Enter your UUID and password{requireAddonPassword ? ' and addon password' : ''} to load your saved configuration.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault(); // Prevent page reload
              handleLogin();
            }}
          >
            <div className="space-y-4">
              {loginError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
                  {loginError}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="uuid">UUID</Label>
                <Input
                  id="uuid"
                  name="username"
                  autoComplete="username"
                  value={uuidInput}
                  onChange={(e) => setUuidInput(e.target.value)}
                  placeholder="Your UUID"
                  disabled={!!uuidFromUrl}
                  className={uuidFromUrl ? "bg-gray-50 text-gray-500 cursor-not-allowed" : ""}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    autoComplete="current-password"
                    type={showPassword ? "text" : "password"}
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="Your password"
                  />
                  <Button
                    type="button" // Important: prevent form submission
                    variant="ghost"
                    size="sm"
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              {requireAddonPassword && isUUIDTrusted === false && (
                <div className="space-y-2">
                  <Label htmlFor="addonPassword">Addon Password</Label>
                  <Input
                    id="addonPassword"
                    name="addon-password"
                    autoComplete="off"
                    type="password"
                    value={addonPasswordInput}
                    onChange={e => setAddonPasswordInput(e.target.value)}
                    placeholder="Enter the addon password"
                    minLength={6}
                  />
                  <p className="text-xs text-muted-foreground mt-1">Required by the addon administrator.</p>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button 
                  type="button" // Keep as button to prevent form submission
                  variant="outline" 
                  onClick={() => setIsLoginOpen(false)}
                >
                  Cancel
                </Button>
                <Button 
                  type="submit" // Change to submit to trigger form submission
                  disabled={isLoading}
                >
                  {isLoading ? 'Loading…' : 'Load'}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </header>
  );
}
