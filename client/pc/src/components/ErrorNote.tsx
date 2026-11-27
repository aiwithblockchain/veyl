import type { CommandError } from "../api";

type Props = {
  error: CommandError | null;
};

/** 错误三段式：发生了什么 / 为什么 / 现在做什么。 */
export function ErrorNote({ error }: Props) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <p className="error__message">{error.message}</p>
      {error.reason ? <p className="error__line">{error.reason}</p> : null}
      {error.hint ? <p className="error__line">{error.hint}</p> : null}
    </div>
  );
}
