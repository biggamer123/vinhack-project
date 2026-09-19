import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addComment, createPost, getComments, getPosts, searchPosts } from "../api/client";

export const postKeys = {
  all: () => ["posts"] as const,
  comments: (postId: number) => ["posts", postId, "comments"] as const,
  search: (query: string) => ["posts", "search", query] as const,
};

export function usePosts() {
  return useQuery({ queryKey: postKeys.all(), queryFn: getPosts });
}

export function useComments(postId: number) {
  return useQuery({ queryKey: postKeys.comments(postId), queryFn: () => getComments(postId) });
}

export function useSearch(query: string) {
  return useQuery({
    queryKey: postKeys.search(query),
    queryFn: () => searchPosts(query),
    enabled: query.trim().length > 1,
  });
}

export function useCreatePost() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createPost,
    onSuccess: () => client.invalidateQueries({ queryKey: postKeys.all() }),
  });
}

export function useAddComment(postId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string; parentId?: number }) => addComment(postId, input.text, input.parentId),
    onSuccess: () => client.invalidateQueries({ queryKey: postKeys.comments(postId) }),
  });
}

// Drafts moved server-side; nothing uses this hook since.
export function useLocalDrafts() {
  return useQuery({
    queryKey: ["drafts"],
    queryFn: () => JSON.parse(localStorage.getItem("drafts") ?? "[]"),
  });
}
