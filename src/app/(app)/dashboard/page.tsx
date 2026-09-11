import type { Metadata } from 'next';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          The booking and front-desk modules arrive in the next phase.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Session shell ready</CardTitle>
          <CardDescription>
            Authentication, the must-change-password gate, 2FA sign-in, and authorization primitives are wired.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
            <li>Signed-in and signed-out flows are guarded server-side.</li>
            <li>Permission helpers are UI-only mirrors; the backend authorizes.</li>
            <li>No booking business UI yet, by design.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}