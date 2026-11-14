import { Monitor, Moon, Rows2, Rows3, Sun } from 'lucide-react'
import { nextTheme, setPrefs, usePrefs } from '../lib/prefs'
import { Button } from './Button'

const themeIcon = { system: Monitor, light: Sun, dark: Moon }

export function PrefsToggles() {
  const prefs = usePrefs()
  const ThemeIcon = themeIcon[prefs.theme]
  const compact = prefs.density === 'compact'
  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        title={`Theme: ${prefs.theme}. Click for ${nextTheme(prefs.theme)}`}
        aria-label={`Theme: ${prefs.theme}, switch`}
        onClick={() => setPrefs({ theme: nextTheme(prefs.theme) })}
      >
        <ThemeIcon className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        title={
          compact
            ? 'Density: compact. Click for comfortable'
            : 'Density: comfortable. Click for compact'
        }
        aria-label="Toggle density"
        onClick={() => setPrefs({ density: compact ? 'comfortable' : 'compact' })}
      >
        {compact ? <Rows3 className="h-4 w-4" /> : <Rows2 className="h-4 w-4" />}
      </Button>
    </>
  )
}
