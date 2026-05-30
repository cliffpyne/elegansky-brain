import {
  Activity,
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
      { title: 'Invoices', path: '/coming-soon', disabled: true },
      { title: 'Payments', path: '/coming-soon', disabled: true },
      { title: 'Arrears', path: '/coming-soon', disabled: true },
      { title: 'Credit memos', path: '/coming-soon', disabled: true },
    ],
  },
  { heading: 'Insights' },
  { title: 'Reports', icon: LineChart, path: '/coming-soon', disabled: true },
  { title: 'Activity', icon: ScrollText, path: '/coming-soon', disabled: true },
  { heading: 'System' },
  { title: 'Webhooks', icon: Webhook, path: '/coming-soon', disabled: true },
  { title: 'Access control', icon: Shield, path: '/coming-soon', disabled: true },
  { title: 'Settings', icon: Settings, path: '/coming-soon', disabled: true },
  { title: 'Help', icon: CircleHelp, path: '/coming-soon', disabled: true },
];

// Other menus referenced by the template — kept aliased so imports elsewhere
// don't break, but they're effectively unused by BRAIN.
export const MENU_SIDEBAR_CUSTOM: MenuConfig = MENU_SIDEBAR;
export const MENU_SIDEBAR_COMPACT: MenuConfig = MENU_SIDEBAR;
export const MENU_MEGA: MenuConfig = [];
export const MENU_MEGA_MOBILE: MenuConfig = MENU_SIDEBAR;
export const MENU_HELP: MenuConfig = [];
export const MENU_ROOT: MenuConfig = MENU_SIDEBAR;
