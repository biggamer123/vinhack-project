import { useState } from "react";
import { usePosts, useSearch } from "../hooks/usePosts";
import { PostCard } from "./PostCard";

export function PostList({ onOpen }: { onOpen: (id: number) => void }) {
  const [query, setQuery] = useState("");
  const posts = usePosts();
  const results = useSearch(query);

  const handleQuery = (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value);

  if (posts.isLoading) {
    return <p>Loading…</p>;
  }
  const cards = query.trim().length > 1 ? (results.data ?? []).map((hit) => hit.post) : posts.data?.cards ?? [];

  return (
    <section>
      <input placeholder="Search posts" value={query} onChange={handleQuery} />
      {cards.map((post) => (
        <PostCard key={post.id} post={post} onOpen={onOpen} />
      ))}
    </section>
  );
}
