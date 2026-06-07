import { Link, useLocation } from 'react-router';
import { cn } from '@/lib/utils';
import { Wallet, FileSpreadsheet, FileText, AlertCircle, TrendingUp } from 'lucide-react';

const tabs = [
  { path: '/everything-report/account-balance', label: 'A · Account balance',  icon: Wallet },
  { path: '/everything-report/sheet-totals',    label: 'B · Sheet totals',     icon: FileSpreadsheet },
  { path: '/everything-report/open-invoices',   label: 'C · Open invoices',    icon: FileText },
  { path: '/everything-report/arrears',         label: 'D · Arrears',          icon: AlertCircle },
  { path: '/everything-report/arrear-trend',    label: 'E · Arrear trend',     icon: TrendingUp },
];

export function EverythingReportSubNav() {
  const { pathname } = useLocation();
  return (
    <div className="flex items-center gap-1 border-b mb-5 overflow-x-auto">
      {tabs.map((t) => {
        const active = pathname.startsWith(t.path);
        const Icon = t.icon;
        return (
          <Link
            key={t.path}
            to={t.path}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
