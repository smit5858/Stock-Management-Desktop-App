import { useMemo, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import Button from './Button';
import { Input, Select } from './Field';
import { useToast } from './Toast';
import { productsApi } from '../api/products';

/**
 * Make + model from the shared vehicle master (the same list as product compatibility), with
 * "add new" inline. `value` is the model id as a string ('' = none).
 * `onCreated(model)` lets the parent reload its list of models.
 */
export default function VehicleModelPicker({ models, value, onChange, onCreated, invalid }) {
  const toast = useToast();
  const current = models.find((m) => String(m.id) === String(value));
  const [make, setMake] = useState(current ? current.make : '');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ make: '', model: '' });
  const shownMake = current ? current.make : make;

  const makes = useMemo(() => [...new Set(models.map((m) => m.make))], [models]);
  const ofMake = models.filter((m) => m.make === shownMake);

  async function add() {
    try {
      const v = await productsApi.createVehicle(draft.make.trim(), draft.model.trim());
      await onCreated?.(v);
      setMake(v.make);
      onChange(String(v.id));
      setAdding(false);
    } catch (e) {
      toast.error(e);
    }
  }

  if (adding) {
    return (
      <div className="flex gap-2">
        <Input
          autoFocus
          list="vehicle-makes"
          placeholder="Make (e.g. Tata)"
          value={draft.make}
          onChange={(e) => setDraft((d) => ({ ...d, make: e.target.value }))}
        />
        <datalist id="vehicle-makes">
          {makes.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Input
          placeholder="Model (e.g. Sierra)"
          value={draft.model}
          onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="icon" variant="primary" icon={Check} title="Add model" onClick={add} />
        <Button size="icon" icon={X} title="Cancel" onClick={() => setAdding(false)} />
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Select
        value={shownMake}
        className={invalid ? 'border-danger' : ''}
        onChange={(e) => {
          setMake(e.target.value);
          onChange('');
        }}
      >
        <option value="">Make…</option>
        {makes.map((m) => (
          <option key={m}>{m}</option>
        ))}
      </Select>
      <Select
        value={value || ''}
        disabled={!shownMake}
        onChange={(e) => onChange(e.target.value)}
        className={invalid ? 'border-danger' : ''}
      >
        <option value="">Model…</option>
        {ofMake.map((m) => (
          <option key={m.id} value={m.id}>
            {m.model}
          </option>
        ))}
      </Select>
      <Button
        size="icon"
        icon={Plus}
        title="Add a make / model that is not in the list"
        onClick={() => {
          setDraft({ make: shownMake, model: '' });
          setAdding(true);
        }}
      />
    </div>
  );
}
