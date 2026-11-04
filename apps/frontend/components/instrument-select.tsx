'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { INSTRUMENTS, Instrument } from '@/lib/client/types';

export function useInstrument(): Instrument {
  const value = useSearchParams().get('instrument');
  return (INSTRUMENTS as readonly string[]).includes(value ?? '') ? (value as Instrument) : 'ABC';
}

export function InstrumentSelect() {
  const instrument = useInstrument();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  return (
    <Select
      value={instrument}
      onValueChange={(next) => {
        const query = new URLSearchParams(params.toString());
        query.set('instrument', next);
        router.replace(`${pathname}?${query.toString()}`);
      }}
    >
      <SelectTrigger className="w-[120px]" aria-label="Instrument">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {INSTRUMENTS.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
