import { Suspense } from 'react'

import { VariableEditor as VariableEditorComponent } from '@/components/variable-editor'

export default function VariableEditor() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <VariableEditorComponent />
    </Suspense>
  )
}
