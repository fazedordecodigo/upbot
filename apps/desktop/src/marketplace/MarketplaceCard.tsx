import type { MarketplaceItem } from "@boto/protocol";
import { marketplaceIcon, marketplaceLogo } from "../lib/marketplace";
import { Icon } from "../ui/icons";

export function MarketplaceLogo({ item }: { item: MarketplaceItem }) {
  const logo = marketplaceLogo(item);
  return (
    <span className={`mk-logo${logo ? " mk-logo-brand" : ""}`}>
      {logo ? <img src={logo} alt="" /> : <Icon name={marketplaceIcon(item.icon)} />}
    </span>
  );
}

export function InstalledBadge() {
  return (
    <span className="badge badge-success">
      <Icon name="circle-check" />
      Instalado
    </span>
  );
}

export function MarketplaceCard({
  item,
  onOpen,
  featured = false,
}: {
  item: MarketplaceItem;
  onOpen: (item: MarketplaceItem) => void;
  featured?: boolean;
}) {
  return (
    <button
      type="button"
      className={`card mk-card${featured ? " mk-card-featured" : ""}`}
      onClick={() => onOpen(item)}
    >
      <span className="od-row">
        <MarketplaceLogo item={item} />
        <span className="od-field od-fill">
          <strong className="od-truncate">{item.name}</strong>
          <span className="mk-author od-truncate">{item.author}</span>
        </span>
      </span>
      <span className="mk-description od-truncate">{item.description}</span>
      <span className="od-cluster">
        <span className="badge badge-secondary">{item.category}</span>
        {item.installed && <InstalledBadge />}
      </span>
    </button>
  );
}
