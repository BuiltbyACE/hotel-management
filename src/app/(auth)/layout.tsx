import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Hotel Management System',
  description: 'Property management system',
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
          HMS
        </div>
        <span className="text-lg font-semibold tracking-tight">Hotel Management System</span>
      </div>
      <main className="w-full max-w-md">{children}</main>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        For support, contact your hotel administrator.
      </p>
    </div>
  );
}