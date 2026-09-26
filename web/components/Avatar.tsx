import { avatarColor, initials } from "@/lib/ledger";

export default function Avatar({
  id,
  name,
  size,
}: {
  id: string;
  name: string;
  size?: number;
}) {
  const style: React.CSSProperties = { background: avatarColor(id) };
  if (size) {
    style.width = size;
    style.height = size;
  }
  return (
    <span className="avatar" style={style}>
      {initials(name)}
    </span>
  );
}
