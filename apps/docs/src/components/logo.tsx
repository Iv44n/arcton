import { Rubik_Spray_Paint } from 'next/font/google'
import { Arcton } from '@/components/icons/arcton'
import { appName } from '@/lib/shared'

const rubikSprayPaint = Rubik_Spray_Paint({
  subsets: ['latin'],
  weight: ['400']
})

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <Arcton className="size-6" />
      <span
        className={`${rubikSprayPaint.className} bg-gradient-to-r from-red-500 to-orange-400 bg-clip-text text-xl text-transparent`}
      >
        {appName}
      </span>
    </span>
  )
}
