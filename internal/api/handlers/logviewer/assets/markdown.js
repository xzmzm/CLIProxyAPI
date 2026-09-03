// Markdown is presentation only: no logged HTML, remote media, or active content.
(function (root) {
  'use strict';
  function createRenderer(document, marked, purifier) {
    const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const parser = new marked.Marked({
      gfm:true,
      breaks:false,
      renderer:{
        html:({text}) => escape(text),
        image:({text}) => '<span class="attachment-placeholder">[Attachment: ' + escape(text || 'image') + ' — not loaded]</span>'
      }
    });
    return text => {
      const node = document.createElement('div');
      node.className = 'markdown-body';
      try {
        if (!purifier.isSupported) throw new Error('HTML sanitization unavailable');
        const html = parser.parse(String(text).replace(/^\uFEFF/, ''));
        const fragment = purifier.sanitize(html, {
          ALLOWED_TAGS:['p','br','strong','em','del','s','blockquote','pre','code','h1','h2','h3','h4','h5','h6','ul','ol','li','hr','table','thead','tbody','tr','th','td','a','span','input'],
          ALLOWED_ATTR:['href','title','class','start','type','checked','disabled','align'],
          ALLOW_DATA_ATTR:false,
          ALLOW_ARIA_ATTR:false,
          ALLOWED_URI_REGEXP:/^(?:https?:\/\/|mailto:)/i,
          RETURN_DOM_FRAGMENT:true
        });
        for (const link of fragment.querySelectorAll('a[href]')) {
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
        }
        for (const input of fragment.querySelectorAll('input')) {
          input.type = 'checkbox';
          input.disabled = true;
          input.setAttribute('aria-label', input.checked ? 'Completed task' : 'Incomplete task');
        }
        for (const table of fragment.querySelectorAll('table')) {
          const scroll = document.createElement('div');
          scroll.className = 'markdown-table';
          table.replaceWith(scroll);
          scroll.append(table);
        }
        node.append(fragment);
      } catch {
        // A parser failure must never cause unsanitized HTML insertion or data loss.
        const fallback = document.createElement('pre');
        fallback.textContent = text;
        node.append(fallback);
      }
      return node;
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {createRenderer};
  else root.LogMarkdown = {render:createRenderer(root.document, root.marked, root.DOMPurify)};
})(typeof window === 'undefined' ? {} : window);
