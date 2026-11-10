'use client'
//重点标记-引入Tiptap组件, 用于编辑变量
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

import { SlashCommand } from './slash-command'

export function VariableEditor() {
  const editor = useEditor({
    // 配置编辑器的扩展, 用于添加功能, 如文本格式化, 图片上传等
    // 你可以根据需要添加扩展, 例如：
    // 你也可以使用StarterKit, 它包含了基本的功能, 如文本格式化, 图片上传等
    extensions: [StarterKit, SlashCommand],
    // 立即渲染编辑器, 避免在组件挂载时渲染为空
    immediatelyRender: false,
  })
  return (
    <div className="h-full">
      <EditorContent editor={editor} />
    </div>
  )
}
