import { useState, useEffect } from "react";
import { useConfig } from "@/contexts/ConfigContext";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Trash2, Lock } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function ConfigImportExport() {
  const { resetConfig: resetConfigFromContext, auth, setAuth } = useConfig();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [addonPassword, setAddonPassword] = useState('');
  const [requiresAddonPassword, setRequiresAddonPassword] = useState(false);


  useEffect(() => {
    fetch("/api/config/addon-info")
      .then(res => res.json())
      .then(data => {
        setRequiresAddonPassword(!!data.requiresAddonPassword);
      })
      .catch(err => {
        console.error('Failed to fetch addon-info:', err);
        setRequiresAddonPassword(false);
      });
  }, []);

  const resetConfig = () => {
    setShowResetDialog(true);
  };

  const handleResetConfirm = () => {
    resetConfigFromContext();
    toast.success("Configuration reset to defaults");
  };

  const deleteUserRecords = async () => {
    if (!auth.userUUID) {
      toast.error("No user account found", {
        description: "You must be logged in to delete your records"
      });
      return;
    }

    setShowPasswordDialog(true);
    console.log("requiresAddonPassword before showing password dialog:", requiresAddonPassword);
  };

  const handlePasswordConfirm = async () => {
    if (!deletePassword.trim()) {
      toast.error("Password is required", {
        description: "Please enter your password to confirm deletion"
      });
      return;
    }

    if (requiresAddonPassword && !addonPassword.trim()) {
      toast.error("Addon Password is required", {
        description: "Please enter the addon password to confirm deletion"
      });
      return;
    }

    setShowPasswordDialog(false);
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    try {
      const body: { password: string; addonPassword?: string } = {
        password: deletePassword
      };

      if (requiresAddonPassword && addonPassword) {
        body.addonPassword = addonPassword;
      }
      
      const response = await fetch(`/api/config/delete-user/${encodeURIComponent(auth.userUUID)}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        toast.success("User records deleted successfully", {
          description: "You have been logged out and all your data has been removed"
        });
        
        // Clear auth state and redirect to home
        setAuth({ authenticated: false, userUUID: null, password: null });
        window.location.href = '/configure';
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete user records');
      }
    } catch (error) {
      console.error('Delete user error:', error);
      toast.error("Failed to delete user records", {
        description: error instanceof Error ? error.message : "Please try again"
      });
    } finally {
      setIsDeleting(false);
      setDeletePassword('');
    }
  };



  return (
    <div className="space-y-6">
      <Card className="border-destructive/20">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>
            Irreversible actions that will affect your configuration and account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Button 
              onClick={resetConfig} 
              variant="destructive"
              className="w-full"
            >
              Reset to Defaults
            </Button>
            <p className="text-xs text-muted-foreground mt-1">
              Reset your configuration to default values. This action cannot be undone.
            </p>
          </div>
          
          {auth.authenticated && auth.userUUID && (
            <div>
              <Button 
                onClick={deleteUserRecords}
                disabled={isDeleting}
                variant="destructive"
                className="w-full"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete User Records
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground mt-1">
                Permanently delete your user account and all associated data. This action cannot be undone.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialogs */}
      <ConfirmDialog
        isOpen={showResetDialog}
        onClose={() => setShowResetDialog(false)}
        onConfirm={handleResetConfirm}
        title="Reset Configuration"
        description="Are you sure you want to reset your configuration to defaults?\n\nThis action cannot be undone."
        confirmText="Reset to Defaults"
        variant="destructive"
      />

      <ConfirmDialog
        isOpen={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={handleDeleteConfirm}
        title="Delete User Records"
        description={`⚠️ WARNING: This will permanently delete ALL your data!

• Your user account
• Your configuration
• Your saved settings
• All associated data

This action CANNOT be undone. Are you absolutely sure?`}
        confirmText="Delete All Data"
        variant="destructive"
        icon={<Trash2 className="h-5 w-5 text-destructive" />}
      />

      {/* Password Dialog */}
      <Dialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-destructive" />
              Confirm Password
            </DialogTitle>
            <DialogDescription>
              Please enter your password to confirm the deletion of your user account and all associated data.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="delete-password">Password</Label>
              <Input
                id="delete-password"
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="Enter your password"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handlePasswordConfirm();
                  }
                }}
              />
            </div>
            {requiresAddonPassword && (
              <div className="space-y-2">
                <Label htmlFor="delete-addon-password">Addon Password</Label>
                <Input
                  id="delete-addon-password"
                  type="password"
                  value={addonPassword}
                  onChange={(e) => setAddonPassword(e.target.value)}
                  placeholder="Enter the addon password"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handlePasswordConfirm();
                    }
                  }}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPasswordDialog(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handlePasswordConfirm}
              disabled={!deletePassword.trim()}
            >
              Confirm Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
