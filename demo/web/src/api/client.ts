export interface Post {
  id: number;
  title: string;
  blurb: string;
  heading: string;
  createdAt?: number;
  tags?: string[];
}

export interface Comment {
  id: number;
  authorId: string;
  body: string;
  createdAt: number;
  replies: Comment[];
}

const BASE = import.meta.env.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
  return response.json() as Promise<T>;
}

export function getPosts(): Promise<{ count: number; cards: Post[] }> {
  return request("/posts");
}

export function getPost(id: number): Promise<Post> {
  return request(`/posts/${id}`);
}

export function createPost(input: { title: string; body: string; tags: string[] }): Promise<Post> {
  return request("/posts", { method: "POST", body: JSON.stringify(input) });
}

export function getComments(postId: number): Promise<Comment[]> {
  return request(`/posts/${postId}/comments`);
}

export function addComment(postId: number, text: string, parentId?: number): Promise<Comment> {
  return request(`/posts/${postId}/comments`, { method: "POST", body: JSON.stringify({ text, parentId }) });
}

export function login(email: string, password: string): Promise<{ ok: boolean }> {
  return request("/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function searchPosts(query: string): Promise<{ post: Post; score: number }[]> {
  return request(`/search?q=${encodeURIComponent(query)}`);
}
