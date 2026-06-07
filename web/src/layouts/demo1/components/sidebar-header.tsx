import { ChevronFirst } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { toAbsoluteUrl } from '@/lib/helpers';
import { useSettings } from '@/providers/settings-provider';
import { Button } from '@/components/ui/button';

export function SidebarHeader() {
  const { settings, storeOption } = useSettings();
  const collapsed = settings.layouts.demo1.sidebarCollapse;

  const handleToggleClick = () => {
    storeOption('layouts.demo1.sidebarCollapse', !collapsed);
  };

  return (
    <div className="sidebar-header hidden lg:flex items-center relative justify-between px-3 lg:px-6 shrink-0">
      <Link to="/" className="flex items-center gap-2">
        <img
          src={toAbsoluteUrl('/media/app/elegansky-logo-256.png')}
          srcSet={`${toAbsoluteUrl('/media/app/elegansky-logo-256.png')} 1x, ${toAbsoluteUrl('/media/app/elegansky-logo.png')} 2x`}
          alt="Elegansky"
          className="size-9 object-contain shrink-0"
        />
        {!collapsed && (
          <span className="text-lg font-bold tracking-tight text-foreground">ELEGANSKY</span>
        )}
      </Link>
      <Button
        onClick={handleToggleClick}
        size="sm"
        mode="icon"
        variant="outline"
        className={cn(
          'size-7 absolute start-full top-2/4 rtl:translate-x-2/4 -translate-x-2/4 -translate-y-2/4',
          settings.layouts.demo1.sidebarCollapse
            ? 'ltr:rotate-180'
            : 'rtl:rotate-180',
        )}
      >
        <ChevronFirst className="size-4!" />
      </Button>
    </div>
  );
}
