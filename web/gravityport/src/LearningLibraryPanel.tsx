// 任务 459：学习库视图右栏的「手册」页签。这张单只有空壳：设计手册、学习
// 记录两段，各一句标题加一句提示（空状态两句的写法）；不放按钮（「开始学习」
// 是后续单的），页签行写在 App.tsx 里，排成以后能再添一项的样子。
import "./learning-library.css"

export function LearningLibraryPanel({ tr }: { tr: (text: string) => string }) {
  return (
    <div className="learn-library-panel">
      <section className="learn-library-section">
        <h3 className="learn-library-heading">{tr("设计手册")}</h3>
        <p className="learn-library-empty-title">{tr("还没有设计手册")}</p>
        <p className="learn-library-empty-hint">{tr("学习这些图片后，配色、构图、光线等要点会整理在这里，每条都标明来自哪几张。")}</p>
      </section>
      <section className="learn-library-section">
        <h3 className="learn-library-heading">{tr("学习记录")}</h3>
        <p className="learn-library-empty-title">{tr("还没有学习记录")}</p>
        <p className="learn-library-empty-hint">{tr("每次学习的图片和手册的改动会记在这里。")}</p>
      </section>
    </div>
  )
}
