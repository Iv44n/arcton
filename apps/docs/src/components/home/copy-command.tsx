'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/cn'

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className={cn(
        'group inline-flex items-center gap-2.5 rounded-full border border-fd-border',
        'bg-fd-secondary/50 py-2.5 pr-2.5 pl-4 font-mono text-sm text-fd-foreground',
        'transition-colors hover:bg-fd-secondary'
      )}
    >
      <span aria-hidden className="select-none text-fd-muted-foreground">
        $
      </span>
      <span>{command}</span>
      <span className="flex size-6 items-center justify-center rounded-full text-fd-muted-foreground transition-colors group-hover:text-fd-foreground">
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </span>
    </button>
  )
}
