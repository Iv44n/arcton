import { type SVGProps, useId } from 'react'

const Arcton = (props: SVGProps<SVGSVGElement>) => {
  const gradientId = useId()

  return (
    <svg {...props} viewBox="0 0 100 100" fill="none">
      <title>Arcton</title>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="14"
          y1="14"
          x2="86"
          y2="86"
        >
          <stop offset="0%" stopColor="#ef4444" />
          <stop offset="100%" stopColor="#fb923c" />
        </linearGradient>
      </defs>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill={`url(#${gradientId})`}
        d="M50 14 A36 36 0 1 1 50 86 A36 36 0 1 1 50 14 Z M56 24 A20 20 0 1 1 56 64 A20 20 0 1 1 56 24 Z"
      />
    </svg>
  )
}

export { Arcton }
