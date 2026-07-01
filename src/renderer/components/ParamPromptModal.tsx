import { useEffect, useRef, useState } from 'react';
import { substituteParams } from '../../shared/buttonBlock';
import type { ParamPromptSpec } from '../lib/paramPrompt';

export function ParamPromptModal(props: {
  spec: ParamPromptSpec;
  onClose: (values: Record<string, string> | null) => void;
}) {
  const { spec, onClose } = props;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of spec.params) init[p.name] = p.default ?? '';
    return init;
  });
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the first field on open.
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  // Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setVal = (name: string, v: string) => {
    setValues((cur) => ({ ...cur, [name]: v }));
    if (error) setError(null);
  };

  const submit = () => {
    for (const p of spec.params) {
      if (p.required && !values[p.name].trim()) {
        setError(`「${p.name}」为必填项`);
        return;
      }
    }
    onClose(values);
  };

  const preview = substituteParams(spec.command, values);

  return (
    <div className="modal-overlay" onClick={() => onClose(null)}>
      <div className="modal param-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">填写参数{spec.edit ? '（编辑模式）' : ''}</div>
        <div className="param-preview">{preview || '(空)'}</div>
        <div className="param-fields">
          {spec.params.map((p, i) => (
            <div className="param-field" key={p.name}>
              <label>{p.name}{p.required ? ' *' : ''}</label>
              <input
                ref={i === 0 ? firstRef : undefined}
                type="text"
                value={values[p.name]}
                list={p.options ? `param-opt-${p.name}` : undefined}
                onChange={(e) => setVal(p.name, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
              />
              {p.options && (
                <datalist id={`param-opt-${p.name}`}>
                  {p.options.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              )}
              {p.hint && <div className="param-hint">{p.hint}</div>}
            </div>
          ))}
        </div>
        {error && <div className="param-error">{error}</div>}
        <div className="modal-actions">
          <button className="primary" onClick={submit}>
            确定
          </button>
          <button onClick={() => onClose(null)}>取消</button>
        </div>
      </div>
    </div>
  );
}
