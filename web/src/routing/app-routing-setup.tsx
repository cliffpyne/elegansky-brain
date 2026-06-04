import { Navigate, Route, Routes } from 'react-router';
import { AuthRouting } from '@/auth/auth-routing';
import { RequireAuth } from '@/auth/require-auth';
import { ErrorRouting } from '@/errors/error-routing';
import { Demo1Layout } from '@/layouts/demo1/layout';
import { StatementCyclesPage } from '@/pages/statement-cycles/statement-cycles-page';
import { StatementCycleDetailPage } from '@/pages/statement-cycles/statement-cycle-detail-page';
import { ArrearsPage } from '@/pages/arrears/arrears-page';
import { AdminSmsPage } from '@/pages/admin-sms/admin-sms-page';
import { PaymentBatchesPage } from '@/pages/payment-batches/payment-batches-page';
import { PaymentBatchDetailPage } from '@/pages/payment-batches/payment-batch-detail-page';
import { AgentPage } from '@/pages/agent/agent-page';
import { AgentSessionDetailPage } from '@/pages/agent/agent-session-detail-page';
import { OfficerReportsPage } from '@/pages/officer-reports/officer-reports-page';

/**
 * BRAIN dashboard routing — slimmed down from Metronic's giant demo router.
 * Only one functional area for now: Statement Cycles.
 *
 *   /                       → redirect to /statement-cycles
 *   /statement-cycles       → list view
 *   /statement-cycles/:id   → drilldown
 *   /auth/*                 → magic-link sign-in
 *   /error/*                → 404 etc.
 */
export function AppRoutingSetup() {
  return (
    <Routes>
      <Route element={<RequireAuth />}>
        <Route element={<Demo1Layout />}>
          <Route index element={<Navigate to="/statement-cycles" replace />} />
          <Route path="/statement-cycles" element={<StatementCyclesPage />} />
          <Route path="/statement-cycles/:id" element={<StatementCycleDetailPage />} />
          <Route path="/arrears" element={<ArrearsPage />} />
          <Route path="/admin-sms" element={<AdminSmsPage />} />
          <Route path="/payment-batches" element={<PaymentBatchesPage />} />
          <Route path="/payment-batches/:id" element={<PaymentBatchDetailPage />} />
          <Route path="/agent" element={<AgentPage />} />
          <Route path="/agent/:id" element={<AgentSessionDetailPage />} />
          <Route path="/officer-reports" element={<OfficerReportsPage />} />
        </Route>
      </Route>
      <Route path="error/*" element={<ErrorRouting />} />
      <Route path="auth/*" element={<AuthRouting />} />
      <Route path="*" element={<Navigate to="/error/404" />} />
    </Routes>
  );
}
