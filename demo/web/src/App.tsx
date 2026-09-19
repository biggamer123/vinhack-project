import { useState } from "react";
import { CommentThread } from "./components/CommentThread";
import { Navbar } from "./components/Navbar";
import { PostList } from "./components/PostList";

export default function App() {
  const [openPost, setOpenPost] = useState<number | null>(null);

  const goHome = () => setOpenPost(null);

  return (
    <main>
      <Navbar onHome={goHome} />
      {openPost === null ? <PostList onOpen={setOpenPost} /> : <CommentThread postId={openPost} />}
    </main>
  );
}
