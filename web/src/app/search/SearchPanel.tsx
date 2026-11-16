import { PanelHeader } from '../../ui/PanelHeader'
import { Results } from './Results'

export function SearchPanel() {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <PanelHeader>SEARCH</PanelHeader>
      <div className="min-h-0 flex-1">
        <Results />
      </div>
    </div>
  )
}
