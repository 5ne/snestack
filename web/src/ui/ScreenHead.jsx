export default function ScreenHead({ title, tools, note, children }) {
  return (
    <header className="screen-head">
      <h2 className="screen-title">{title}</h2>
      {tools}
      {note && <span className="screen-note">{note}</span>}
      <span className="spacer" />
      {children}
    </header>
  );
}
