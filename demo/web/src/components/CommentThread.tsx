import { useState } from "react";
import type { Comment } from "../api/client";
import { useAddComment, useComments } from "../hooks/usePosts";
import { timeAgo } from "../lib/time";

function CommentItem({ comment, onReply }: { comment: Comment; onReply: (id: number) => void }) {
  return (
    <li>
      <p>{comment.body}</p>
      <small>
        {timeAgo(comment.createdAt)} · <button onClick={() => onReply(comment.id)}>reply</button>
      </small>
      {comment.replies.length > 0 && (
        <ul>
          {comment.replies.map((reply) => (
            <CommentItem key={reply.id} comment={reply} onReply={onReply} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CommentThread({ postId }: { postId: number }) {
  const comments = useComments(postId);
  const add = useAddComment(postId);
  const [text, setText] = useState("");
  const [parentId, setParentId] = useState<number | undefined>();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    add.mutate({ text, parentId });
    setText("");
    setParentId(undefined);
  };

  return (
    <section className="comments">
      <ul>
        {(comments.data ?? []).map((comment) => (
          <CommentItem key={comment.id} comment={comment} onReply={setParentId} />
        ))}
      </ul>
      <form onSubmit={submit}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} />
        <button disabled={!text.trim() || add.isPending}>{parentId ? "Reply" : "Comment"}</button>
      </form>
    </section>
  );
}
