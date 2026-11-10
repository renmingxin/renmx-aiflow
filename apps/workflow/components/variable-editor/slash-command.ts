import { Extension } from '@tiptap/core'
import Suggestion, { SuggestionOptions } from '@tiptap/suggestion'

export interface SlashCommandItem {
  type: 'node' | 'variable'
}

export interface SlashCommandOptions {
  suggestion: Omit<SuggestionOptions<SlashCommandItem>, 'editor'>
}
// 重点标记-定义SlashCommand扩展, 用于添加斜杠命令功能, 如 /变量名,
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',
  addOptions() {
    return {
      suggestion: {
        char: '/',
        // 允许在任意位置触发, 默认 [' '] 只允许行首或空格后触发
        // allowedPrefixes: null,
        command: ({ editor, range, props }) => {
          console.log('slashCommand', { editor, range, props })
          // 插入变量名或节点名, 如 /变量名, /节点名, /函数名, /常量名
          editor.commands.insertContentAt(range, props.item.type)
        },
      },
    }
  },
  // 添加ProseMirror插件, 用于实现斜杠命令功能
  addProseMirrorPlugins() {
    // 添加Suggestion插件, 用于实现斜杠命令功能
    // 你可以根据需要添加其他插件, 例如：
    // 你也可以使用StarterKit, 它包含了基本的功能, 如文本格式化, 图片上传等
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        // 定义建议框的项目, 如变量名, 节点名, 函数名, 常量名等
        items: this.options.suggestion.items,
        render: () => {
          return {
            // onStart 用于在用户输入斜杠后, 触发建议框的显示
            onStart: view => {
              console.log('onStart', view)
            },
            // onEnd: view => {
            //   console.log('onEnd', view)
            // },
          }
        },
      }),
    ]
  },
})
