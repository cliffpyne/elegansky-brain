import { Container } from '@/components/common/container';

export function Footer() {
  const currentYear = new Date().getFullYear();
  // Template footer links (Docs / Purchase / FAQ / Support / License) point at
  // Keenthemes — not relevant for the BRAIN operator. Render them disabled
  // (muted, no href, no hover) so the layout stays the same but nothing
  // navigates off-site.
  const inactiveLinks = ['Docs', 'Purchase', 'FAQ', 'Support', 'License'];
  return (
    <footer className="footer">
      <Container>
        <div className="flex flex-col md:flex-row justify-center md:justify-between items-center gap-3 py-5">
          <div className="flex order-2 md:order-1 gap-2 font-normal text-sm">
            <span className="text-muted-foreground">{currentYear} &copy;</span>
            <span className="text-secondary-foreground">Elegansky Microfinance</span>
          </div>
          <nav className="flex order-1 md:order-2 gap-4 font-normal text-sm text-muted-foreground/60">
            {inactiveLinks.map((label) => (
              <span key={label} className="cursor-not-allowed" aria-disabled="true">
                {label}
              </span>
            ))}
          </nav>
        </div>
      </Container>
    </footer>
  );
}
