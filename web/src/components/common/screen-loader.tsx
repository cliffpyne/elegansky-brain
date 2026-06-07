'use client';

import { toAbsoluteUrl } from '@/lib/helpers';

export function ScreenLoader() {
  return (
    <div className="flex flex-col items-center gap-3 justify-center fixed inset-0 z-50 transition-opacity duration-700 ease-in-out">
      <img
        className="h-16 w-16 max-w-none animate-pulse-scale"
        src={toAbsoluteUrl('/media/app/elegansky-logo-256.png')}
        srcSet={`${toAbsoluteUrl('/media/app/elegansky-logo-256.png')} 1x, ${toAbsoluteUrl('/media/app/elegansky-logo.png')} 2x`}
        alt="Elegansky"
      />
      <div className="text-muted-foreground font-medium text-sm">
        Loading...
      </div>
      <style>{`
        @keyframes pulse-scale {
          0%, 100% { transform: scale(0.92); opacity: 0.75; }
          50%      { transform: scale(1.08); opacity: 1; }
        }
        .animate-pulse-scale { animation: pulse-scale 1.4s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
