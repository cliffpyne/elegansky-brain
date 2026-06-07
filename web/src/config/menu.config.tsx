import {
  Activity,
  Bell,
  Bot,
  CircleHelp,
  FileSpreadsheet,
  Landmark,
  LayoutGrid,
  LineChart,
  ScrollText,
  Settings,
  Shield,
  Webhook,
} from 'lucide-react';
import { type MenuConfig } from './types';

/**
 * BRAIN sidebar — only the sections we actually own.
 * "Soon" items show in muted style so the operator knows what's coming.
 */
export const MENU_SIDEBAR: MenuConfig = [
  {
    title: 'Overview',
    icon: LayoutGrid,
    children: [{ title: 'Statement Cycles', path: '/statement-cycles', icon: Activity }],
  },
  { heading: 'Operations' },
  {
    title: 'NMB + CRDB',
    icon: Landmark,
    children: [
      { title: 'Statement Cycles', path: '/statement-cycles' },
      { title: 'Big Data Queue', path: '/coming-soon', disabled: true },
    ],
  },
  {
    title: 'QuickBooks',
    icon: FileSpreadsheet,
    children: [
      { title: 'Arrears', path: '/arrears' },
      { title: 'Payment batches', path: '/payment-batches' },
      { title: 'Invoices', path: '/coming-soon', disabled: true },
      { title: 'Credit memos', path: '/coming-soon', disabled: true },
    ],
  },
  { title: 'Agent', icon: Bot, path: '/agent' },
  { heading: 'Insights' },
  { title: 'Officer collections', icon: LineChart, path: '/officer-reports' },
  { title: 'Everything report', icon: LineChart, path: '/everything-report' },
  { title: 'Activity', icon: ScrollText, path: '/coming-soon', disabled: true },
  { heading: 'System' },
  { title: 'Admin notifications', icon: Bell, path: '/admin-sms' },
  { title: 'Webhooks', icon: Webhook, path: '/coming-soon', disabled: true },
  { title: 'Access control', icon: Shield, path: '/coming-soon', disabled: true },
  { title: 'Settings', icon: Settings, path: '/coming-soon', disabled: true },
  { title: 'Help', icon: CircleHelp, path: '/coming-soon', disabled: true },
];

// Other menus referenced by the template — kept aliased so imports elsewhere
// don't break, but they're effectively unused by BRAIN.
export const MENU_SIDEBAR_CUSTOM: MenuConfig = MENU_SIDEBAR;
export const MENU_SIDEBAR_COMPACT: MenuConfig = MENU_SIDEBAR;
// MENU_MEGA must have at least 6 items because demo1's mega-menu reads them
// by index ([0]..[5]) — `undefined.title` blanks the whole React tree. We
// fill the slots with the sidebar items so accesses are safe even though the
// top horizontal nav becomes a (harmless) duplicate of the sidebar.
const _megaSlots: MenuConfig = [
  { title: 'Overview', path: '/statement-cycles', children: [] },
  { title: 'Operations', path: '/statement-cycles', children: [] },
  { title: 'Insights', path: '/coming-soon', children: [], disabled: true },
  { title: 'System', path: '/coming-soon', children: [], disabled: true },
  { title: 'Settings', path: '/coming-soon', children: [], disabled: true },
  { title: 'Help', path: '/coming-soon', children: [], disabled: true },
];
export const MENU_MEGA: MenuConfig = _megaSlots;
export const MENU_MEGA_MOBILE: MenuConfig = MENU_SIDEBAR;
export const MENU_HELP: MenuConfig = [];
export const MENU_ROOT: MenuConfig = MENU_SIDEBAR;
